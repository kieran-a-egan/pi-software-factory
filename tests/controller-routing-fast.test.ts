import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as agents from "../src/agent-runner.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { runFactory } from "../src/controller.js";
import { JevDecisionEngine } from "../src/jev.js";
import * as runSafety from "../src/run-safety.js";
import type { RunSafetyEvidence } from "../src/run-safety.js";
import * as storage from "../src/storage.js";
import type { RunStore } from "../src/storage.js";
import * as verification from "../src/verification.js";
import type {
  ArchitectureResult,
  FactoryConfig,
  FactoryDecisionRecord,
  FactoryProgressEvent,
  ModelRef,
  ReviewGateDecision,
  ReviewResult,
  ScoutResult,
  VerificationResult,
} from "../src/types.js";
import { makeCheckpointFixture, makeFakeModelRuntime, makeScoutResultFixture, makeWorkerReportFixture } from "./helpers/agent-runner-harness.js";

/**
 * Fast, in-memory port of the role-routing, repair, telemetry, and
 * checkpoint tests from tests/controller-reliability.test.ts. The real
 * runFactory() controller flow (routing, Jev gate wiring, telemetry,
 * counters, progress events, model resolution, checkpoint and continuation
 * resumption, repair loops, failure wording, source disposition) runs
 * unmodified; only the infrastructure boundaries are replaced with local
 * typed doubles:
 *   - createRunStore  -> in-memory RunStore (path-shaped dir, JSON round-trips)
 *   - reserveRun      -> source transaction with a deterministic conclude
 *     disposition: unknown-retained plus an error when writer quiescence is
 *     uncertain, accepted-in-place for accepted runs, unchanged otherwise
 *   - gitStatus       -> "" (clean tree, no Git subprocess)
 *   - verify          -> ordered verification-result sequence; fresh passing
 *     results by default, deterministic repair scenarios supply complete
 *     ordered outcomes and assert the verification call count
 *   - runCheckpointableAgent -> ordered checkpoint/result segment sequence;
 *     validated results by default, checkpoints carry the real unit id and
 *     the established 70_000 tokens / 100_000 window / 70% context fixture
 *     with metrics following the supplied role ModelRef
 * plus the established JevDecisionEngine prototype, ModelRuntime.create, and
 * agent-runner mocks. workerId resolves implementer prompts' currentUnit ids
 * and repair prompts' top-level unitIds (verification-repair-N /
 * review-repair-N), including checkpoint-resumed and Jev-continued
 * re-entries. No Git repository is initialized, no source snapshots or
 * worktrees are created, no worker files are written, and no verification
 * command is executed: the fixture units carry no filesExpected and
 * parallelImplementation is disabled, so the Git-backed code paths are never
 * reachable.
 */

const roleModels: FactoryConfig["models"] = {
  scout: { provider: "prov-scout", model: "model-scout", thinking: "low" },
  architect: { provider: "prov-architect", model: "model-architect", thinking: "xhigh" },
  implementer: { provider: "prov-implementer", model: "model-implementer", thinking: "minimal" },
  reviewer: { provider: "prov-reviewer", model: "model-reviewer", thinking: "high" },
  repairer: { provider: "prov-repairer", model: "model-repairer", thinking: "off" },
};

const runnerMetrics = (model: ModelRef): agents.AgentRunMetrics => ({
  model: `${model.provider}/${model.model}`, cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/**
 * Unit id embedded in the real worker prompt's serialized factory input.
 * Implementer prompts carry currentUnit.id; deterministic and review repair
 * prompts (including checkpoint-resumed and Jev-continued re-entries, whose
 * prompts reuse the same base payload) carry a top-level unitId such as
 * verification-repair-N or review-repair-N.
 */
const workerId = (prompt: string) =>
  /"currentUnit":\s*\{\s*"id": "([^"]+)"/.exec(prompt)?.[1]
  ?? /"unitId": "([^"]+)"/.exec(prompt)?.[1]
  ?? "a";

/** Fresh passing verification evidence; diff is a string because doReview slices it. */
const passingVerification = (): VerificationResult => ({
  passed: true,
  checks: [],
  gitStatus: "",
  diffStat: "",
  diff: "",
});

/** Failed verification evidence for deterministic repair scenarios. */
const failingVerification = (): VerificationResult => ({
  passed: false,
  checks: [{ command: "npm test", passed: false, exitCode: 1, output: "fixture check failure" }],
  gitStatus: "",
  diffStat: "",
  diff: "",
});

interface FakeRunStore {
  store: RunStore;
  /** Written artifact name -> JSON round-tripped value (mirrors file contents). */
  written: Map<string, unknown>;
  decisions: unknown[];
}

/**
 * Local RunStore double: a path-shaped dir (runFactory derives the run id via
 * dir.split(/[\\/]/).pop()), JSON-round-tripped written values, recorded
 * decisions, and writeState delegating to write("state.json", state) exactly
 * like the real store. No filesystem access.
 */
function makeFakeRunStore(root: string): FakeRunStore {
  const written = new Map<string, unknown>();
  const decisions: unknown[] = [];
  const store: RunStore = {
    dir: join(root, "SF-fast-fixture"),
    write: (name, value) => {
      written.set(name, JSON.parse(JSON.stringify(value)));
    },
    appendDecision: (value) => {
      decisions.push(JSON.parse(JSON.stringify(value)));
    },
    writeState: (state) => {
      store.write("state.json", state);
    },
  };
  return { store, written, decisions };
}

type SourceTransaction = Awaited<ReturnType<typeof runSafety.reserveRun>>;

interface FakeSourceTransaction {
  transaction: SourceTransaction;
  beginCalls: string[][];
  concludeCalls: Array<{
    accepted: boolean;
    verifiedDiff?: string;
    writerQuiescenceUncertain: boolean;
    ignoredPrefixes: string[];
    retainedWorktrees: string[];
  }>;
  releaseCalls: number;
}

/**
 * Local reserveRun double: active evidence, a no-op begin, and a no-op
 * release. conclude mirrors the real transaction's disposition branches as a
 * deterministic fixture policy — unknown-retained with an error when writer
 * quiescence is uncertain, accepted-in-place for accepted runs, unchanged
 * otherwise — without any source capture, lock, or Git operation. Every call
 * is recorded so the harness can confirm the controller traversed it.
 */
function makeFakeSourceTransaction(runDir: string): FakeSourceTransaction {
  const evidence: RunSafetyEvidence = {
    disposition: "active-unaccepted",
    lockPath: join(runDir, "pi-software-factory.lock"),
    runDir,
  };
  const beginCalls: string[][] = [];
  const concludeCalls: FakeSourceTransaction["concludeCalls"] = [];
  let releaseCalls = 0;
  const transaction: SourceTransaction = {
    evidence,
    begin: (ignoredPrefixes) => {
      beginCalls.push(ignoredPrefixes);
      return Promise.resolve();
    },
    conclude: async (input, ignoredPrefixes, retainedWorktrees) => {
      concludeCalls.push({ ...input, ignoredPrefixes, retainedWorktrees });
      if (input.writerQuiescenceUncertain) {
        return {
          ...evidence,
          disposition: "unknown-retained",
          error: "Fixture writer quiescence is uncertain; human confirmation that all source-writing processes have stopped is required.",
        };
      }
      return { ...evidence, disposition: input.accepted ? "accepted-in-place" : "unchanged" };
    },
    release: () => {
      releaseCalls += 1;
    },
  };
  return {
    transaction,
    beginCalls,
    concludeCalls,
    get releaseCalls() {
      return releaseCalls;
    },
  };
}

let cwd: string;
let config: FactoryConfig;
let architecture: ArchitectureResult;
let review: ReviewResult;
let gate: ReviewGateDecision;
let runnerCalls: Array<{ fn: "runAgent" | "runCheckpointableAgent"; role: string; model: ModelRef }>;
let reviewCalls: number;
let reviewSequence: ReviewResult[];
let scoutFactory: () => ScoutResult = () => makeScoutResultFixture();
let fakeStore: FakeRunStore | undefined;
let fakeTransactions: FakeSourceTransaction[];
let gitStatusCalls: Array<{ cwd: string; ignoredPrefixes: string[] }>;
let verifyCalls: Array<{ cwd: string; commands: string[]; ignoredPrefixes: string[] }>;
/** Ordered verification outcomes consumed by verify; empty means fresh passing results. */
let verificationSequence: VerificationResult[];
/** Ordered worker segments consumed by runCheckpointableAgent; absent entries default to "result". */
let workerSegmentSequence: Array<"checkpoint" | "result">;

const run = (progress: (event: FactoryProgressEvent) => void = () => {}) =>
  runFactory(cwd, "fixture routing change", config, progress);

beforeEach(() => {
  // Empty temporary directory only: a safe cwd for project-context lookup. No
  // Git initialization and no worker file writes in this suite.
  cwd = mkdtempSync(join(tmpdir(), "pi-sf-routing-fast-"));
  config = structuredClone(DEFAULT_CONFIG);
  config.parallelImplementation.enabled = false;
  architecture = {
    summary: "fixture", approach: "bounded", architecturalDecisions: [], risks: [], assumptions: [], verificationStrategy: [],
    implementationUnits: ["a", "b"].map((id) => ({ id, objective: id, acceptance: [], constraints: [], dependsOn: [] })),
  };
  review = { summary: "clean", verdict: "clean", findings: [], testGaps: [], requirementCoverage: [] };
  gate = { action: "accept", confidence: 1, residualRisk: "low", reviewSufficientProbability: 0.57, raw: { score: 0.57 } };
  runnerCalls = [];
  reviewCalls = 0;
  reviewSequence = [review];
  scoutFactory = () => makeScoutResultFixture();
  fakeStore = undefined;
  fakeTransactions = [];
  gitStatusCalls = [];
  verifyCalls = [];
  verificationSequence = [];
  workerSegmentSequence = [];
  vi.stubEnv("TYPESAFE_API_KEY", "offline-fixture");
  vi.spyOn(ModelRuntime, "create").mockResolvedValue(makeFakeModelRuntime());
  vi.spyOn(JevDecisionEngine.prototype, "classifyIntake").mockResolvedValue({
    taskType: "bug", requirementClarity: "clear", statedRisk: "low", confidence: { requirementClarity: 1 }, raw: {},
  });
  vi.spyOn(JevDecisionEngine.prototype, "gatePlan").mockResolvedValue({
    action: "proceed", confidence: 1, planCompleteProbability: 1, implementationRisk: "low", rescoutFocus: "none", replanFocus: "none", raw: {},
  });
  vi.spyOn(JevDecisionEngine.prototype, "gateWorker").mockResolvedValue({ disposition: "ready", confidence: 1, raw: {} });
  vi.spyOn(JevDecisionEngine.prototype, "gateReview").mockImplementation(async () => structuredClone(gate));
  vi.spyOn(storage, "createRunStore").mockImplementation((root) => {
    fakeStore = makeFakeRunStore(root);
    return fakeStore.store;
  });
  vi.spyOn(runSafety, "reserveRun").mockImplementation(async (_cwd, store) => {
    const fake = makeFakeSourceTransaction(store.dir);
    fakeTransactions.push(fake);
    return fake.transaction;
  });
  vi.spyOn(verification, "gitStatus").mockImplementation(async (cwdArg, ignoredPrefixes = []) => {
    gitStatusCalls.push({ cwd: cwdArg, ignoredPrefixes });
    return "";
  });
  vi.spyOn(verification, "verify").mockImplementation(async (cwdArg, commands, ignoredPrefixes = []) => {
    verifyCalls.push({ cwd: cwdArg, commands, ignoredPrefixes });
    // Ordered sequence control: explicit repair scenarios supply complete
    // ordered outcomes; the ordinary default remains a fresh passing result.
    const index = verifyCalls.length - 1;
    return index < verificationSequence.length ? verificationSequence[index] : passingVerification();
  });
  vi.spyOn(agents, "runAgent").mockImplementation(async (options) => {
    runnerCalls.push({ fn: "runAgent", role: options.role, model: options.model });
    return {
      result: options.validate(
        options.role === "scout" ? scoutFactory()
          : options.role === "architect" ? architecture
          : reviewSequence[Math.min(reviewCalls++, reviewSequence.length - 1)],
      ), metrics: runnerMetrics(options.model),
    };
  });
  vi.spyOn(agents, "runCheckpointableAgent").mockImplementation(async (options) => {
    runnerCalls.push({ fn: "runCheckpointableAgent", role: options.role, model: options.model });
    const index = runnerCalls.filter((call) => call.fn === "runCheckpointableAgent").length - 1;
    const id = workerId(options.prompt);
    // Ordered segment control: explicit checkpoint scenarios name the exact
    // segments that end in a checkpoint; the ordinary default is a validated
    // result. Checkpoints carry the real unit id and the established context
    // fixture, with metrics following the supplied role ModelRef.
    if (workerSegmentSequence[index] === "checkpoint") {
      return {
        kind: "checkpoint",
        checkpoint: makeCheckpointFixture({ unitId: id }),
        context: { tokens: 70_000, contextWindow: 100_000, percent: 70 },
        metrics: runnerMetrics(options.model),
      };
    }
    return {
      kind: "result",
      result: options.validate(makeWorkerReportFixture({ unitId: id, changedFiles: [`${id}.txt`] })),
      metrics: runnerMetrics(options.model),
    };
  });
});

afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("controller role routing (fast, in-memory boundaries)", () => {
  it("routes scout to models.scout and architect/reviewer to their role ModelRefs", async () => {
    config.models = structuredClone(roleModels);
    const state = await run();
    expect(state.finalStatus).toBe("accepted");
    expect(runnerCalls.filter((call) => call.fn === "runAgent")).toEqual([
      { fn: "runAgent", role: "scout", model: roleModels.scout },
      { fn: "runAgent", role: "architect", model: roleModels.architect },
      { fn: "runAgent", role: "reviewer", model: roleModels.reviewer },
    ]);
    expect(state.telemetry?.find((stage) => stage.stage === "scout")).toMatchObject({
      stage: "scout", actor: "agent", model: "prov-scout/model-scout", outcome: "completed",
    });
    expect(state.telemetry?.find((stage) => stage.stage === "architect")).toMatchObject({
      stage: "architect", actor: "agent", model: "prov-architect/model-architect", outcome: "completed",
    });
    expect(state.telemetry?.find((stage) => stage.stage === "reviewer")).toMatchObject({
      stage: "reviewer", actor: "agent", model: "prov-reviewer/model-reviewer", outcome: "completed",
    });
    // The controller traversed the local fake boundaries end to end.
    expect(fakeStore?.store.dir).toBe(join(cwd, ".pi", "software-factory", "runs", "SF-fast-fixture"));
    expect(fakeStore?.written.has("state.json")).toBe(true);
    expect(fakeStore?.written.has("source-disposition.json")).toBe(true);
    expect(fakeStore?.written.has("run-summary.json")).toBe(true);
    expect(fakeTransactions).toHaveLength(1);
    expect(fakeTransactions[0].beginCalls).toEqual([[".pi/software-factory/runs"]]);
    expect(fakeTransactions[0].concludeCalls).toEqual([
      { accepted: true, verifiedDiff: "", writerQuiescenceUncertain: false, ignoredPrefixes: [".pi/software-factory/runs"], retainedWorktrees: [] },
    ]);
    expect(fakeTransactions[0].releaseCalls).toBe(1);
    expect(gitStatusCalls).toEqual([{ cwd, ignoredPrefixes: [".pi/software-factory/runs"] }]);
    expect(verifyCalls).toEqual([
      { cwd, commands: config.verificationCommands, ignoredPrefixes: [".pi/software-factory/runs"] },
      { cwd, commands: config.verificationCommands, ignoredPrefixes: [".pi/software-factory/runs"] },
    ]);
  });

  it("routes rescout and the post-rescout replan to their role ModelRefs", async () => {
    config.models = structuredClone(roleModels);
    vi.mocked(JevDecisionEngine.prototype.gatePlan).mockResolvedValueOnce({
      action: "rescout", confidence: 1, planCompleteProbability: 1, implementationRisk: "low", rescoutFocus: "dependencies", replanFocus: "none", raw: {},
    });
    const started: Array<[string, string | undefined, string]> = [];
    const state = await run((event) => {
      if (event.type === "started" && event.model !== undefined && event.model !== config.jev.model) {
        started.push([event.stage, event.label, event.model]);
      }
    });
    expect(state.finalStatus, state.finalReason).toBe("accepted");
    expect(state.rescoutPasses).toBe(1);
    // The rescout loop re-runs the scout and then the architect (replan); the
    // run then proceeds to the initial review as usual.
    expect(runnerCalls.filter((call) => call.fn === "runAgent")).toEqual([
      { fn: "runAgent", role: "scout", model: roleModels.scout },
      { fn: "runAgent", role: "architect", model: roleModels.architect },
      { fn: "runAgent", role: "scout", model: roleModels.scout },
      { fn: "runAgent", role: "architect", model: roleModels.architect },
      { fn: "runAgent", role: "reviewer", model: roleModels.reviewer },
    ]);
    // Started progress events carry the same role selection as the runners,
    // including the planning-loop rescout and post-rescout replan stages.
    expect(started).toEqual([
      ["scout", undefined, "prov-scout/model-scout"],
      ["architect", undefined, "prov-architect/model-architect"],
      ["scout", "rescout pass 1 · dependencies", "prov-scout/model-scout"],
      ["architect", "replan pass 1 · after rescout 1", "prov-architect/model-architect"],
      ["implementer", "implementation unit a", "prov-implementer/model-implementer"],
      ["implementer", "implementation unit b", "prov-implementer/model-implementer"],
      ["reviewer", undefined, "prov-reviewer/model-reviewer"],
    ]);
    expect(state.telemetry?.find((stage) => stage.stage === "scout" && stage.label !== undefined)).toMatchObject({
      stage: "scout", label: "rescout pass 1 · dependencies", actor: "agent", model: "prov-scout/model-scout", outcome: "completed",
    });
    expect(state.telemetry?.find((stage) => stage.stage === "architect" && stage.label !== undefined)).toMatchObject({
      stage: "architect", label: "replan pass 1 · after rescout 1", actor: "agent", model: "prov-architect/model-architect", outcome: "completed",
    });
    expect(fakeStore?.written.get("architecture-after-rescout-1.json")).toEqual(state.architecture);
  });

  it("routes an explicit replan to models.architect with the replan focus label", async () => {
    config.models = structuredClone(roleModels);
    vi.mocked(JevDecisionEngine.prototype.gatePlan).mockResolvedValueOnce({
      action: "replan", confidence: 1, planCompleteProbability: 1, implementationRisk: "low", rescoutFocus: "none", replanFocus: "scope", raw: {},
    });
    const started: Array<[string, string | undefined, string]> = [];
    const state = await run((event) => {
      if (event.type === "started" && event.model !== undefined && event.model !== config.jev.model) {
        started.push([event.stage, event.label, event.model]);
      }
    });
    expect(state.finalStatus, state.finalReason).toBe("accepted");
    expect(state.replanPasses).toBe(1);
    expect(runnerCalls.filter((call) => call.fn === "runAgent" && call.role === "architect")).toEqual([
      { fn: "runAgent", role: "architect", model: roleModels.architect },
      { fn: "runAgent", role: "architect", model: roleModels.architect },
    ]);
    // The explicit replan route reports the architect role's model on its
    // started event with the replan focus label.
    expect(started).toEqual([
      ["scout", undefined, "prov-scout/model-scout"],
      ["architect", undefined, "prov-architect/model-architect"],
      ["architect", "replan pass 1 · scope", "prov-architect/model-architect"],
      ["implementer", "implementation unit a", "prov-implementer/model-implementer"],
      ["implementer", "implementation unit b", "prov-implementer/model-implementer"],
      ["reviewer", undefined, "prov-reviewer/model-reviewer"],
    ]);
    expect(state.telemetry?.find((stage) => stage.stage === "architect" && stage.label !== undefined)).toMatchObject({
      stage: "architect", label: "replan pass 1 · scope", actor: "agent", model: "prov-architect/model-architect", outcome: "completed",
    });
    expect(fakeStore?.written.get("architecture-replan-1.json")).toEqual(state.architecture);
  });

  it("routes sequential implementer workers to models.implementer", async () => {
    config.models = structuredClone(roleModels);
    const state = await run();
    expect(state.finalStatus).toBe("accepted");
    expect(runnerCalls.filter((call) => call.fn === "runCheckpointableAgent")).toEqual([
      { fn: "runCheckpointableAgent", role: "implementer", model: roleModels.implementer },
      { fn: "runCheckpointableAgent", role: "implementer", model: roleModels.implementer },
    ]);
    expect(state.telemetry?.filter((stage) => stage.stage === "implementer").map((stage) => [stage.stage, stage.actor, stage.model, stage.outcome])).toEqual([
      ["implementer", "agent", "prov-implementer/model-implementer", "completed"],
      ["implementer", "agent", "prov-implementer/model-implementer", "completed"],
    ]);
  });

  it("routes the initial and post-repair reviews to models.reviewer, never models.architect", async () => {
    config.models = structuredClone(roleModels);
    const requested: ReviewResult = {
      summary: "changes requested",
      verdict: "changes_requested",
      findings: [{ severity: "minor", title: "Inconsistent naming", explanation: "b.txt content is inconsistent with the objective.", file: "b.txt" }],
      testGaps: [], requirementCoverage: [],
    };
    reviewSequence = [requested, review];
    vi.mocked(JevDecisionEngine.prototype.gateReview).mockResolvedValueOnce({ ...gate, action: "rework" });
    const state = await run();
    expect(state.finalStatus).toBe("accepted");
    expect(state.reviewRepairPasses).toBe(1);
    const reviewerCalls = runnerCalls.filter((call) => call.fn === "runAgent" && call.role === "reviewer");
    expect(reviewerCalls).toEqual([
      { fn: "runAgent", role: "reviewer", model: roleModels.reviewer },
      { fn: "runAgent", role: "reviewer", model: roleModels.reviewer },
    ]);
    for (const call of reviewerCalls) expect(call.model).not.toEqual(roleModels.architect);
    expect(state.telemetry?.filter((stage) => stage.stage === "reviewer").map((stage) => [stage.stage, stage.actor, stage.model, stage.outcome])).toEqual([
      ["reviewer", "agent", "prov-reviewer/model-reviewer", "completed"],
      ["reviewer", "agent", "prov-reviewer/model-reviewer", "completed"],
    ]);
  });

  it("routes both deterministic and review repairer workers to models.repairer, never models.implementer", async () => {
    config.models = structuredClone(roleModels);
    // Ordered verification outcomes: baseline pass, post-implementation fail
    // (drives the deterministic repair), post-repair pass, post-review-repair
    // pass. The call count pins the exact verification stages.
    verificationSequence = [passingVerification(), failingVerification(), passingVerification(), passingVerification()];
    const requested: ReviewResult = {
      summary: "changes requested",
      verdict: "changes_requested",
      findings: [{ severity: "minor", title: "Inconsistent naming", explanation: "b.txt content is inconsistent with the objective.", file: "b.txt" }],
      testGaps: [], requirementCoverage: [],
    };
    reviewSequence = [requested, review];
    vi.mocked(JevDecisionEngine.prototype.gateReview).mockResolvedValueOnce({ ...gate, action: "rework" });
    const started: Array<[string, string | undefined, string]> = [];
    const state = await run((event) => {
      if (event.type === "started" && event.model !== undefined && event.model !== config.jev.model) {
        started.push([event.stage, event.label, event.model]);
      }
    });
    expect(state.finalStatus).toBe("accepted");
    expect(state.deterministicRepairPasses).toBe(1);
    expect(state.reviewRepairPasses).toBe(1);
    expect(verifyCalls).toHaveLength(4);
    expect(runnerCalls.filter((call) => call.fn === "runCheckpointableAgent").map((call) => call.role)).toEqual([
      "implementer", "implementer", "repairer", "repairer",
    ]);
    for (const call of runnerCalls.filter((call) => call.fn === "runCheckpointableAgent")) {
      expect(call.model).toEqual(roleModels[call.role as "implementer" | "repairer"]);
    }
    for (const call of runnerCalls.filter((call) => call.fn === "runCheckpointableAgent" && call.role === "repairer")) {
      expect(call.model).not.toEqual(roleModels.implementer);
    }
    expect(state.telemetry?.filter((stage) => stage.stage === "repairer").map((stage) => [stage.stage, stage.actor, stage.model, stage.outcome])).toEqual([
      ["repairer", "agent", "prov-repairer/model-repairer", "completed"],
      ["repairer", "agent", "prov-repairer/model-repairer", "completed"],
    ]);
    // Both repair classes and the post-repair review keep their role models on
    // started events.
    expect(started).toEqual([
      ["scout", undefined, "prov-scout/model-scout"],
      ["architect", undefined, "prov-architect/model-architect"],
      ["implementer", "implementation unit a", "prov-implementer/model-implementer"],
      ["implementer", "implementation unit b", "prov-implementer/model-implementer"],
      ["repairer", "deterministic repair 1", "prov-repairer/model-repairer"],
      ["reviewer", undefined, "prov-reviewer/model-reviewer"],
      ["repairer", "review repair 1", "prov-repairer/model-repairer"],
      ["reviewer", "after review repair 1", "prov-reviewer/model-reviewer"],
    ]);
  });

  it("keeps the repairer ModelRef across a checkpointed deterministic repair resumption", async () => {
    config.models = structuredClone(roleModels);
    // Ordered verification outcomes: baseline pass, post-implementation fail
    // (drives the deterministic repair), post-repair pass. The call count pins
    // the exact verification stages.
    verificationSequence = [passingVerification(), failingVerification(), passingVerification()];
    // The first deterministic repair segment ends in a context checkpoint; the
    // controller resumes a fresh worker for the same pass.
    workerSegmentSequence = ["result", "result", "checkpoint"];
    const started: Array<[string, string | undefined, string]> = [];
    const state = await run((event) => {
      if (event.type === "started" && event.model !== undefined && event.model !== config.jev.model) {
        started.push([event.stage, event.label, event.model]);
      }
    });
    expect(state.finalStatus, state.finalReason).toBe("accepted");
    expect(state.deterministicRepairPasses).toBe(1);
    expect(state.reviewRepairPasses).toBe(0);
    expect(verifyCalls).toHaveLength(3);
    expect(state.checkpoints).toHaveLength(1);
    expect(state.checkpoints?.[0]).toMatchObject({ stage: "repairer", label: "deterministic repair 1", index: 1 });
    const checkpoint = fakeStore?.written.get("checkpoint-deterministic-repair-1-1.json") as
      | { stage?: string; label?: string; index?: number; checkpoint?: { unitId?: string } }
      | undefined;
    expect(checkpoint).toMatchObject({ stage: "repairer", label: "deterministic repair 1", index: 1 });
    // The repair worker's unit id is verification-repair-<pass>; the artifact
    // stem remains deterministic-repair-<pass>.
    expect(checkpoint?.checkpoint).toMatchObject({ unitId: "verification-repair-1" });
    // The resumed segment kept the repairer role's ModelRef; four worker calls
    // in total, two of them the repair segments.
    expect(runnerCalls.filter((call) => call.fn === "runCheckpointableAgent")).toEqual([
      { fn: "runCheckpointableAgent", role: "implementer", model: roleModels.implementer },
      { fn: "runCheckpointableAgent", role: "implementer", model: roleModels.implementer },
      { fn: "runCheckpointableAgent", role: "repairer", model: roleModels.repairer },
      { fn: "runCheckpointableAgent", role: "repairer", model: roleModels.repairer },
    ]);
    expect(state.telemetry?.filter((stage) => stage.stage === "repairer").map((stage) => [stage.stage, stage.actor, stage.model, stage.outcome])).toEqual([
      ["repairer", "agent", "prov-repairer/model-repairer", "completed"],
      ["repairer", "agent", "prov-repairer/model-repairer", "completed"],
    ]);
    // The resumed repair segment starts under the same repairer model.
    expect(started).toEqual([
      ["scout", undefined, "prov-scout/model-scout"],
      ["architect", undefined, "prov-architect/model-architect"],
      ["implementer", "implementation unit a", "prov-implementer/model-implementer"],
      ["implementer", "implementation unit b", "prov-implementer/model-implementer"],
      ["repairer", "deterministic repair 1", "prov-repairer/model-repairer"],
      ["repairer", "deterministic repair 1 · resume 1", "prov-repairer/model-repairer"],
      ["reviewer", undefined, "prov-reviewer/model-reviewer"],
    ]);
    // The persisted StageTelemetry records the same role selection, including
    // the resumed repair segment.
    const persistedTelemetry = fakeStore?.written.get("telemetry.json") as
      Array<{ stage?: string; label?: string; model?: string; outcome?: string }> | undefined;
    expect(persistedTelemetry
      ?.filter((stage) => stage.model !== undefined && stage.model !== config.jev.model)
      .map((stage) => [stage.stage, stage.label, stage.model, stage.outcome]))
      .toEqual([
        ["scout", undefined, "prov-scout/model-scout", "completed"],
        ["architect", undefined, "prov-architect/model-architect", "completed"],
        ["implementer", "implementation unit a", "prov-implementer/model-implementer", "completed"],
        ["implementer", "implementation unit b", "prov-implementer/model-implementer", "completed"],
        ["repairer", "deterministic repair 1", "prov-repairer/model-repairer", "completed"],
        ["repairer", "deterministic repair 1 · resume 1", "prov-repairer/model-repairer", "completed"],
        ["reviewer", undefined, "prov-reviewer/model-reviewer", "completed"],
      ]);
    const afterRepair = fakeStore?.written.get("verification-after-deterministic-repair-1.json") as VerificationResult | undefined;
    expect(afterRepair?.passed).toBe(true);
  });

  it("keeps the repairer ModelRef across a Jev-continuation review repair resumption", async () => {
    config.models = structuredClone(roleModels);
    const requested: ReviewResult = {
      summary: "changes requested",
      verdict: "changes_requested",
      findings: [{ severity: "minor", title: "Inconsistent naming", explanation: "b.txt content is inconsistent with the objective.", file: "b.txt" }],
      testGaps: [], requirementCoverage: [],
    };
    reviewSequence = [requested, review];
    vi.mocked(JevDecisionEngine.prototype.gateReview).mockResolvedValueOnce({ ...gate, action: "rework" });
    vi.mocked(JevDecisionEngine.prototype.gateWorker)
      .mockResolvedValueOnce({ disposition: "ready", confidence: 1, raw: {} })
      .mockResolvedValueOnce({ disposition: "ready", confidence: 1, raw: {} })
      .mockResolvedValueOnce({ disposition: "continue", confidence: 1, raw: {} })
      .mockResolvedValueOnce({ disposition: "ready", confidence: 1, raw: {} });
    const started: Array<[string, string | undefined, string]> = [];
    const state = await run((event) => {
      if (event.type === "started" && event.model !== undefined && event.model !== config.jev.model) {
        started.push([event.stage, event.label, event.model]);
      }
    });
    expect(state.finalStatus, state.finalReason).toBe("accepted");
    expect(state.deterministicRepairPasses).toBe(0);
    expect(state.reviewRepairPasses).toBe(1);
    expect(state.workerContinuations).toHaveLength(1);
    expect(state.workerContinuations?.[0]).toMatchObject({
      phase: "repair", label: "review repair 1", pass: 1, priorDisposition: "continue",
      repairClass: "review", repairPass: 1,
    });
    const continuation = fakeStore?.written.get("continuation-review-repair-1-1.json") as
      | { phase?: string; pass?: number; priorDisposition?: string; repairClass?: string; repairPass?: number }
      | undefined;
    expect(continuation).toMatchObject({
      phase: "repair", pass: 1, priorDisposition: "continue",
      repairClass: "review", repairPass: 1,
    });
    // The continuation segment kept the repairer role's ModelRef.
    expect(runnerCalls.filter((call) => call.fn === "runCheckpointableAgent")).toEqual([
      { fn: "runCheckpointableAgent", role: "implementer", model: roleModels.implementer },
      { fn: "runCheckpointableAgent", role: "implementer", model: roleModels.implementer },
      { fn: "runCheckpointableAgent", role: "repairer", model: roleModels.repairer },
      { fn: "runCheckpointableAgent", role: "repairer", model: roleModels.repairer },
    ]);
    expect(state.telemetry?.filter((stage) => stage.stage === "repairer").map((stage) => [stage.stage, stage.actor, stage.model, stage.outcome])).toEqual([
      ["repairer", "agent", "prov-repairer/model-repairer", "completed"],
      ["repairer", "agent", "prov-repairer/model-repairer", "completed"],
    ]);
    // The continuation segment and the post-repair review keep their role
    // models on started events.
    expect(started).toEqual([
      ["scout", undefined, "prov-scout/model-scout"],
      ["architect", undefined, "prov-architect/model-architect"],
      ["implementer", "implementation unit a", "prov-implementer/model-implementer"],
      ["implementer", "implementation unit b", "prov-implementer/model-implementer"],
      ["reviewer", undefined, "prov-reviewer/model-reviewer"],
      ["repairer", "review repair 1", "prov-repairer/model-repairer"],
      ["repairer", "review repair 1 · continue 1", "prov-repairer/model-repairer"],
      ["reviewer", "after review repair 1", "prov-reviewer/model-reviewer"],
    ]);
    // The persisted StageTelemetry records the same role selection, including
    // the continued repair segment and the post-repair review.
    const persistedTelemetry = fakeStore?.written.get("telemetry.json") as
      Array<{ stage?: string; label?: string; model?: string; outcome?: string }> | undefined;
    expect(persistedTelemetry
      ?.filter((stage) => stage.model !== undefined && stage.model !== config.jev.model)
      .map((stage) => [stage.stage, stage.label, stage.model, stage.outcome]))
      .toEqual([
        ["scout", undefined, "prov-scout/model-scout", "completed"],
        ["architect", undefined, "prov-architect/model-architect", "completed"],
        ["implementer", "implementation unit a", "prov-implementer/model-implementer", "completed"],
        ["implementer", "implementation unit b", "prov-implementer/model-implementer", "completed"],
        ["reviewer", undefined, "prov-reviewer/model-reviewer", "completed"],
        ["repairer", "review repair 1", "prov-repairer/model-repairer", "completed"],
        ["repairer", "review repair 1 · continue 1", "prov-repairer/model-repairer", "completed"],
        ["reviewer", "after review repair 1", "prov-reviewer/model-reviewer", "completed"],
      ]);
  });

  it("reports each role's provider/model on started progress events and completed telemetry, including resumed segments", async () => {
    config.models = structuredClone(roleModels);
    // The first implementation segment (unit a) ends in a context checkpoint;
    // the controller resumes a fresh worker for the same unit.
    workerSegmentSequence = ["checkpoint"];
    const started: Array<[string, string]> = [];
    const state = await run((event) => {
      if (event.type === "started" && event.model !== undefined && event.model !== config.jev.model) {
        started.push([event.stage, event.model]);
      }
    });
    expect(state.finalStatus, state.finalReason).toBe("accepted");
    // Model-backed stages, in execution order, each report the selected
    // role's configured provider/model — including the resumed segment.
    const expected: Array<[string, string]> = [
      ["scout", "prov-scout/model-scout"],
      ["architect", "prov-architect/model-architect"],
      ["implementer", "prov-implementer/model-implementer"],
      ["implementer", "prov-implementer/model-implementer"],
      ["implementer", "prov-implementer/model-implementer"],
      ["reviewer", "prov-reviewer/model-reviewer"],
    ];
    expect(started).toEqual(expected);
    expect((state.telemetry ?? [])
      .filter((stage) => stage.model !== undefined && stage.model !== config.jev.model)
      .map((stage) => [stage.stage, stage.model, stage.outcome]))
      .toEqual(expected.map(([stage, model]) => [stage, model, "completed"]));
    // The persisted telemetry matches the same role selection, including the
    // resumed implementation segment.
    const persistedTelemetry = fakeStore?.written.get("telemetry.json") as
      Array<{ stage?: string; label?: string; model?: string; outcome?: string }> | undefined;
    expect(persistedTelemetry
      ?.filter((stage) => stage.model !== undefined && stage.model !== config.jev.model)
      .map((stage) => [stage.stage, stage.label, stage.model, stage.outcome]))
      .toEqual([
        ["scout", undefined, "prov-scout/model-scout", "completed"],
        ["architect", undefined, "prov-architect/model-architect", "completed"],
        ["implementer", "implementation unit a", "prov-implementer/model-implementer", "completed"],
        ["implementer", "implementation unit a · resume 1", "prov-implementer/model-implementer", "completed"],
        ["implementer", "implementation unit b", "prov-implementer/model-implementer", "completed"],
        ["reviewer", undefined, "prov-reviewer/model-reviewer", "completed"],
      ]);
  });

  it("reports the runner's actual metrics.model in completed telemetry while started events keep the configured model", async () => {
    config.models = structuredClone(roleModels);
    vi.mocked(agents.runAgent).mockImplementation(async (options) => {
      runnerCalls.push({ fn: "runAgent", role: options.role, model: options.model });
      return {
        result: options.validate(
          options.role === "scout" ? scoutFactory()
            : options.role === "architect" ? architecture
            : reviewSequence[Math.min(reviewCalls++, reviewSequence.length - 1)],
        ),
        // The scout runner reports a model independent of the configured
        // ModelRef, so telemetry must follow the actual metrics.
        metrics: options.role === "scout"
          ? { model: "runtime-resolved/scout-model", cost: 0, tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } }
          : runnerMetrics(options.model),
      };
    });
    const started: Array<[string, string | undefined]> = [];
    const state = await run((event) => {
      if (event.type === "started") started.push([event.stage, event.model]);
    });
    expect(state.finalStatus).toBe("accepted");
    expect(started.find(([stage]) => stage === "scout")).toEqual(["scout", "prov-scout/model-scout"]);
    const scoutTelemetry = state.telemetry?.find((stage) => stage.stage === "scout");
    expect(scoutTelemetry?.model).toBe("runtime-resolved/scout-model");
    expect(scoutTelemetry?.model).not.toBe("prov-scout/model-scout");
    expect(scoutTelemetry?.model).not.toBe("agent");
    expect(scoutTelemetry?.tokens).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 });
  });

  it("emits and persists semantic stage and actor identifiers for every stage, with no qwen/astra stages", async () => {
    config.models = structuredClone(roleModels);
    const state = await run();
    expect(state.finalStatus).toBe("accepted");
    expect((state.telemetry ?? []).map((stage) => [stage.stage, stage.actor])).toEqual([
      ["preflight", "controller"],
      ["baseline-verify", "tools"],
      ["intake", "jev"],
      ["scout", "agent"],
      ["architect", "agent"],
      ["plan-gate", "jev"],
      ["implementer", "agent"],
      ["worker-gate", "jev"],
      ["implementer", "agent"],
      ["worker-gate", "jev"],
      ["verify", "tools"],
      ["reviewer", "agent"],
      ["review-gate", "jev"],
    ]);
    // Newly emitted stage names and labels carry no model branding; model
    // references are asserted separately and are never filtered here.
    for (const stage of state.telemetry ?? []) {
      expect(stage.stage.toLowerCase()).not.toMatch(/qwen|astra/);
      if (stage.label !== undefined) expect(stage.label.toLowerCase()).not.toMatch(/qwen|astra/);
    }
    // Jev stages keep the Jev actor and the configured Jev model.
    expect((state.telemetry ?? []).filter((stage) => stage.actor === "jev").map((stage) => stage.model))
      .toEqual(["jev-latest", "jev-latest", "jev-latest", "jev-latest", "jev-latest"]);
    // Agent stages keep the full configured provider/model reference.
    expect((state.telemetry ?? []).filter((stage) => stage.actor === "agent").map((stage) => stage.model))
      .toEqual([
        "prov-scout/model-scout",
        "prov-architect/model-architect",
        "prov-implementer/model-implementer",
        "prov-implementer/model-implementer",
        "prov-reviewer/model-reviewer",
      ]);
    // Initial scout and architecture retain no special label.
    expect(state.telemetry?.find((stage) => stage.stage === "scout")?.label).toBeUndefined();
    expect(state.telemetry?.find((stage) => stage.stage === "architect")?.label).toBeUndefined();
    // The persisted artifacts carry the same semantic identifiers.
    const ordered = (state.telemetry ?? []).map((stage) => [stage.stage, stage.actor]);
    const persistedTelemetry = fakeStore?.written.get("telemetry.json") as
      Array<{ stage?: string; actor?: string }> | undefined;
    expect(persistedTelemetry?.map((stage) => [stage.stage, stage.actor])).toEqual(ordered);
    const persistedState = fakeStore?.written.get("state.json") as
      | { telemetry?: Array<{ stage?: string; actor?: string }> }
      | undefined;
    expect(persistedState?.telemetry?.map((stage) => [stage.stage, stage.actor])).toEqual(ordered);
    // Decision records keep their existing semantic stage names and order.
    expect(fakeStore?.decisions.map((decision) => (decision as { stage?: string }).stage)).toEqual([
      "intake", "plan-gate", "worker-gate", "worker-gate", "review-gate", "final-review-routing",
    ]);
  });

  it("persists checkpoint artifacts and state checkpoints with the implementer stage", async () => {
    config.models = structuredClone(roleModels);
    // The first implementation segment (unit a) ends in a context checkpoint;
    // the controller resumes a fresh worker for the same unit.
    workerSegmentSequence = ["checkpoint"];
    const state = await run();
    expect(state.finalStatus, state.finalReason).toBe("accepted");
    const checkpoint = fakeStore?.written.get("checkpoint-implementation-a-1.json") as
      | { stage?: string; label?: string; index?: number; checkpoint?: { unitId?: string } }
      | undefined;
    expect(checkpoint).toMatchObject({ stage: "implementer", label: "implementation unit a", index: 1 });
    // The implementer worker's checkpoint carries the real currentUnit id; the
    // artifact stem remains implementation-<unit>.
    expect(checkpoint?.checkpoint).toMatchObject({ unitId: "a" });
    expect(state.checkpoints).toHaveLength(1);
    expect(state.checkpoints?.[0]).toMatchObject({ stage: "implementer", label: "implementation unit a", index: 1 });
    // The terminal state.json carries the same checkpoint record.
    const persistedState = fakeStore?.written.get("state.json") as
      | { checkpoints?: Array<{ stage?: string; label?: string; index?: number }> }
      | undefined;
    expect(persistedState?.checkpoints).toEqual(state.checkpoints);
    // The persisted telemetry keeps the semantic stage, the agent actor, and
    // the configured provider/model reference for both implementer segments
    // of unit a (original and checkpoint-resumed) and unit b.
    const persistedTelemetry = fakeStore?.written.get("telemetry.json") as
      Array<{ stage?: string; label?: string; actor?: string; model?: string; outcome?: string }> | undefined;
    expect(persistedTelemetry
      ?.filter((stage) => stage.stage === "implementer")
      .map((stage) => [stage.stage, stage.label, stage.actor, stage.model, stage.outcome]))
      .toEqual([
        ["implementer", "implementation unit a", "agent", "prov-implementer/model-implementer", "completed"],
        ["implementer", "implementation unit a · resume 1", "agent", "prov-implementer/model-implementer", "completed"],
        ["implementer", "implementation unit b", "agent", "prov-implementer/model-implementer", "completed"],
      ]);
  });

  it("names the Implementer role in a context-checkpoint failure final reason", async () => {
    config.models = structuredClone(roleModels);
    vi.mocked(agents.runCheckpointableAgent).mockImplementation(async () => {
      throw new Error("context checkpoint threshold not met");
    });
    const state = await run();
    expect(state.finalStatus).toBe("human");
    expect(state.finalReason).toMatch(/^Implementer context checkpoint failed for implementation unit a: /);
    expect(state.finalReason).not.toMatch(/qwen|astra/i);
    expect(state.telemetry?.some((stage) => stage.stage === "implementer" && stage.outcome === "failed")).toBe(true);
    expect(state.sourceDisposition?.disposition).toBe("unknown-retained");
  });

  it("names the Implementer role in a worker timeout final reason", async () => {
    config.models = structuredClone(roleModels);
    vi.mocked(agents.runCheckpointableAgent).mockImplementation(async () => {
      throw new Error("exceeded max runtime");
    });
    const state = await run();
    expect(state.finalStatus).toBe("human");
    expect(state.finalReason).toMatch(/^Implementer worker timed out for implementation unit a: /);
    expect(state.finalReason).not.toMatch(/qwen|astra/i);
    expect(state.telemetry?.some((stage) => stage.stage === "implementer" && stage.outcome === "failed")).toBe(true);
    expect(state.sourceDisposition?.disposition).toBe("unknown-retained");
  });

  it("names the Implementer role in a checkpoint-limit final reason after four checkpoint records", async () => {
    config.models = structuredClone(roleModels);
    vi.mocked(agents.runCheckpointableAgent).mockImplementation(async (options) => {
      runnerCalls.push({ fn: "runCheckpointableAgent", role: options.role, model: options.model });
      // Every implementer segment ends in a checkpoint, so the segment loop
      // exceeds maxCheckpointsPerStage on the fourth segment.
      return {
        kind: "checkpoint",
        checkpoint: makeCheckpointFixture({ unitId: workerId(options.prompt) }),
        context: { tokens: 70_000, contextWindow: 100_000, percent: 70 },
        metrics: runnerMetrics(options.model),
      };
    });
    const state = await run();
    expect(state.finalStatus).toBe("human");
    expect(state.finalReason).toBe("Implementer exceeded maxCheckpointsPerStage (3) for implementation unit a.");
    expect(state.finalReason).not.toMatch(/qwen|astra/i);
    expect(state.checkpoints).toHaveLength(4);
    expect(state.checkpoints?.map((checkpoint) => [checkpoint.stage, checkpoint.index])).toEqual([
      ["implementer", 1], ["implementer", 2], ["implementer", 3], ["implementer", 4],
    ]);
    expect(state.sourceDisposition?.disposition).toBe("unchanged");
  });

  it("names the Repairer role in a context-checkpoint failure final reason", async () => {
    config.models = structuredClone(roleModels);
    // Ordered verification outcomes: baseline pass, post-implementation fail
    // (drives the deterministic repair). The implementers succeed and only
    // the repairer segment fails. The call count pins the exact verification
    // stages.
    verificationSequence = [passingVerification(), failingVerification()];
    vi.mocked(agents.runCheckpointableAgent).mockImplementation(async (options) => {
      if (options.role === "implementer") {
        runnerCalls.push({ fn: "runCheckpointableAgent", role: options.role, model: options.model });
        const id = workerId(options.prompt);
        return {
          kind: "result",
          result: options.validate(makeWorkerReportFixture({ unitId: id, changedFiles: [`${id}.txt`] })),
          metrics: runnerMetrics(options.model),
        };
      }
      throw new Error("context checkpoint threshold not met");
    });
    const state = await run();
    expect(state.finalStatus).toBe("human");
    expect(state.finalReason).toMatch(/^Repairer context checkpoint failed for deterministic repair 1: /);
    expect(state.finalReason).not.toMatch(/qwen|astra/i);
    expect(state.telemetry?.some((stage) => stage.stage === "repairer" && stage.outcome === "failed")).toBe(true);
    expect(state.sourceDisposition?.disposition).toBe("unknown-retained");
    expect(verifyCalls).toHaveLength(2);
  });
});

describe("controller repair budgets (fast, in-memory boundaries)", () => {
  /**
   * Ordered role/unitId evidence derived from the existing worker spy: the
   * implementer prompts carry currentUnit ids, and the repair prompts carry
   * top-level unitIds (verification-repair-N / review-repair-N). The spy's
   * implementation and the runnerCalls entries remain unchanged.
   */
  const workerAssignments = () =>
    vi.mocked(agents.runCheckpointableAgent).mock.calls.map((call) => ({
      role: call[0].role,
      unitId: workerId(call[0].prompt),
    }));

  /** Typed stage filter over the fake store's recorded decision records. */
  const decisionsOf = (stage: string) =>
    (fakeStore?.decisions ?? [])
      .filter((decision) => (decision as { stage?: string }).stage === stage)
      .map((decision) => decision as FactoryDecisionRecord);

  /** Typed view of the persisted repair counters and routing in a written artifact. */
  const persistedRunFacts = (name: string) =>
    fakeStore?.written.get(name) as
      | {
          deterministicRepairPasses?: number;
          reviewRepairPasses?: number;
          repairPasses?: number;
          reviewRouting?: { outcome?: string };
        }
      | undefined;

  it("persists one review repair with re-verification and final routing under the independent review budget", async () => {
    vi.mocked(JevDecisionEngine.prototype.gateReview).mockResolvedValueOnce({ ...gate, action: "rework" });
    const state = await run();
    expect(state.finalStatus).toBe("accepted");
    expect(state.deterministicRepairPasses).toBe(0);
    expect(state.reviewRepairPasses).toBe(1);
    expect(state.repairPasses).toBe(1);
    // Exactly two implementation assignments plus the one review repair
    // assignment; the deterministic budget is untouched.
    expect(workerAssignments()).toEqual([
      { role: "implementer", unitId: "a" },
      { role: "implementer", unitId: "b" },
      { role: "repairer", unitId: "review-repair-1" },
    ]);
    expect(runnerCalls.filter((call) => call.fn === "runCheckpointableAgent")).toHaveLength(3);
    // Baseline, post-implementation, and post-review-repair verification; the
    // default sequence keeps every outcome passing. The call count pins the
    // exact verification stages.
    expect(verifyCalls).toHaveLength(3);
    const postRepairVerification = fakeStore?.written.get("verification-after-review-repair-1.json") as VerificationResult | undefined;
    expect(postRepairVerification?.passed).toBe(true);
    expect(fakeStore?.written.get("review-after-repair-1.json")).toEqual(review);
    expect(fakeStore?.written.get("review-gate-after-repair-1.json")).toEqual(gate);
    // The repair worker-gate and review-gate records carry the review class
    // and pass.
    expect(decisionsOf("worker-gate").find((decision) => decision.repairClass === "review"))
      .toMatchObject({ stage: "worker-gate", phase: "repair", repairClass: "review", repairPass: 1 });
    expect(decisionsOf("review-gate").find((decision) => decision.repairClass === "review"))
      .toMatchObject({ stage: "review-gate", repairClass: "review", repairPass: 1 });
    // The default gate sufficiency stays below the normal-acceptance bound.
    expect(state.reviewRouting?.outcome).toBe("bounded-low-sufficiency-acceptance");
    // The persisted counters and routing agree with the returned state.
    const expectedCounters = {
      deterministicRepairPasses: state.deterministicRepairPasses,
      reviewRepairPasses: state.reviewRepairPasses,
      repairPasses: state.repairPasses,
    };
    const persistedState = persistedRunFacts("state.json");
    expect(persistedState).toMatchObject(expectedCounters);
    expect(persistedState?.reviewRouting).toEqual(state.reviewRouting);
    const runSummary = persistedRunFacts("run-summary.json");
    expect(runSummary).toMatchObject(expectedCounters);
    expect(runSummary?.reviewRouting).toEqual(state.reviewRouting);
    expect(fakeStore?.written.get("review-routing.json")).toEqual(state.reviewRouting);
  });

  it("accepts after exactly two review repairs, each with concrete findings and passing re-verification", async () => {
    gate.reviewSufficientProbability = 0.65; // normal acceptance, not the low-sufficiency bound
    const firstReview: ReviewResult = {
      summary: "changes requested",
      verdict: "changes_requested",
      findings: [{ severity: "minor", title: "Missing error handling", explanation: "The fixture path does not handle a failed read of a.txt.", file: "a.txt", suggestedFix: "Handle the failure path." }],
      testGaps: [], requirementCoverage: [],
    };
    const secondReview: ReviewResult = {
      summary: "still changes requested",
      verdict: "changes_requested",
      findings: [{ severity: "minor", title: "Unhandled edge case", explanation: "The repaired path still leaves an unhandled edge case in b.txt.", file: "b.txt", suggestedFix: "Cover the edge case." }],
      testGaps: [], requirementCoverage: [],
    };
    const cleanReview: ReviewResult = { summary: "clean after both repairs", verdict: "clean", findings: [], testGaps: [], requirementCoverage: [] };
    reviewSequence = [firstReview, secondReview, cleanReview];
    vi.mocked(JevDecisionEngine.prototype.gateReview)
      .mockResolvedValueOnce({ ...gate, action: "rework" })
      .mockResolvedValueOnce({ ...gate, action: "rework" })
      .mockResolvedValueOnce({ ...gate, action: "accept" });

    const state = await run();

    expect(state.finalStatus).toBe("accepted");
    expect(state.reviewRouting?.outcome).toBe("normal-acceptance");
    // Exactly two ordered review repair assignments; the deterministic budget
    // is untouched.
    expect(workerAssignments()).toEqual([
      { role: "implementer", unitId: "a" },
      { role: "implementer", unitId: "b" },
      { role: "repairer", unitId: "review-repair-1" },
      { role: "repairer", unitId: "review-repair-2" },
    ]);
    expect(state.deterministicRepairPasses).toBe(0);
    expect(state.reviewRepairPasses).toBe(2);
    expect(state.repairPasses).toBe(2);
    expect(runnerCalls.filter((call) => call.fn === "runCheckpointableAgent")).toHaveLength(4);
    // Baseline, post-implementation, and one re-verification per repair pass.
    // The call count pins the exact verification stages.
    expect(verifyCalls).toHaveLength(4);
    // Passing re-verification after each repair.
    expect((fakeStore?.written.get("verification-after-review-repair-1.json") as VerificationResult | undefined)?.passed).toBe(true);
    expect((fakeStore?.written.get("verification-after-review-repair-2.json") as VerificationResult | undefined)?.passed).toBe(true);
    // Both post-repair review and gate artifacts exist with the expected
    // content.
    expect(fakeStore?.written.get("review-after-repair-1.json")).toEqual(secondReview);
    expect(fakeStore?.written.get("review-after-repair-2.json")).toEqual(cleanReview);
    expect(fakeStore?.written.get("review-gate-after-repair-1.json")).toMatchObject({ action: "rework" });
    expect(fakeStore?.written.get("review-gate-after-repair-2.json")).toMatchObject({ action: "accept" });
    // Decision history identifies class and pass for the review class and
    // preserves the final routing evidence.
    const workerGates = decisionsOf("worker-gate").filter((decision) => decision.repairClass === "review");
    expect(workerGates.map((decision) => decision.repairPass)).toEqual([1, 2]);
    const reviewGates = decisionsOf("review-gate").filter((decision) => decision.repairClass === "review");
    expect(reviewGates.map((decision) => [decision.repairPass, (decision.decision as { action?: string }).action]))
      .toEqual([[1, "rework"], [2, "accept"]]);
    const routing = decisionsOf("final-review-routing");
    expect(routing).toHaveLength(1);
    expect((routing[0].routing as { outcome?: string }).outcome).toBe("normal-acceptance");
    // The persisted counters and routing agree with the returned state.
    const expectedCounters = {
      deterministicRepairPasses: state.deterministicRepairPasses,
      reviewRepairPasses: state.reviewRepairPasses,
      repairPasses: state.repairPasses,
    };
    const persistedState = persistedRunFacts("state.json");
    expect(persistedState).toMatchObject(expectedCounters);
    expect(persistedState?.reviewRouting).toEqual(state.reviewRouting);
    const runSummary = persistedRunFacts("run-summary.json");
    expect(runSummary).toMatchObject(expectedCounters);
    expect(runSummary?.reviewRouting).toEqual(state.reviewRouting);
    expect(fakeStore?.written.get("review-routing.json")).toEqual(state.reviewRouting);
  });

  it("stops at the default review repair budget after exactly two review repairs, creates no next-pass artifact, and reaches HUMAN through final-review routing", async () => {
    // The review gate stays rework for every pass; verification keeps
    // passing under the default sequence, so only the bounded review budget
    // can end the loop.
    gate.action = "rework";
    const state = await run();
    expect(state.finalStatus).toBe("human");
    expect(state.deterministicRepairPasses).toBe(0);
    expect(state.reviewRepairPasses).toBe(DEFAULT_CONFIG.maxReviewRepairPasses);
    expect(state.repairPasses).toBe(DEFAULT_CONFIG.maxReviewRepairPasses);
    // Exactly two review repair assignments; the deterministic budget is
    // untouched.
    expect(workerAssignments()).toEqual([
      { role: "implementer", unitId: "a" },
      { role: "implementer", unitId: "b" },
      { role: "repairer", unitId: "review-repair-1" },
      { role: "repairer", unitId: "review-repair-2" },
    ]);
    expect(runnerCalls.filter((call) => call.fn === "runCheckpointableAgent")).toHaveLength(4);
    // Baseline, post-implementation, and one re-verification per repair
    // pass. The call count pins the exact verification stages.
    expect(verifyCalls).toHaveLength(4);
    expect(state.reviewRouting?.outcome).toBe("human-fallback");
    // The bounded loop persisted every allowed pass's worker, gate, and
    // verification artifacts, each with passing verification...
    for (let pass = 1; pass <= DEFAULT_CONFIG.maxReviewRepairPasses; pass++) {
      expect(fakeStore?.written.has(`review-repair-${pass}.json`)).toBe(true);
      expect(fakeStore?.written.has(`review-repair-gate-${pass}.json`)).toBe(true);
      expect((fakeStore?.written.get(`verification-after-review-repair-${pass}.json`) as VerificationResult | undefined)?.passed).toBe(true);
    }
    // ...and no third (next-pass) worker, gate, or verification artifact
    // exists.
    expect(fakeStore?.written.has("review-repair-3.json")).toBe(false);
    expect(fakeStore?.written.has("review-repair-gate-3.json")).toBe(false);
    expect(fakeStore?.written.has("verification-after-review-repair-3.json")).toBe(false);
    // The final (still rework) gate is persisted and drives the HUMAN routing.
    expect(fakeStore?.written.get("review-gate-after-repair-2.json")).toEqual(gate);
    // The persisted counters and routing agree with the returned state.
    const expectedCounters = {
      deterministicRepairPasses: state.deterministicRepairPasses,
      reviewRepairPasses: state.reviewRepairPasses,
      repairPasses: state.repairPasses,
    };
    const persistedState = persistedRunFacts("state.json");
    expect(persistedState).toMatchObject(expectedCounters);
    expect(persistedState?.reviewRouting).toEqual(state.reviewRouting);
    const runSummary = persistedRunFacts("run-summary.json");
    expect(runSummary).toMatchObject(expectedCounters);
    expect(runSummary?.reviewRouting).toEqual(state.reviewRouting);
  });

  it("honors an explicit non-default review repair budget, creating no next-pass artifact and reaching HUMAN through final-review routing", async () => {
    config.maxReviewRepairPasses = 3;
    // The review gate stays rework for every pass; verification keeps
    // passing under the default sequence, so only the explicit review budget
    // can end the loop.
    gate.action = "rework";
    const state = await run();
    expect(state.finalStatus).toBe("human");
    expect(state.deterministicRepairPasses).toBe(0);
    expect(state.reviewRepairPasses).toBe(3);
    expect(state.repairPasses).toBe(3);
    // Exactly three review repair assignments; the deterministic budget is
    // untouched.
    expect(workerAssignments()).toEqual([
      { role: "implementer", unitId: "a" },
      { role: "implementer", unitId: "b" },
      { role: "repairer", unitId: "review-repair-1" },
      { role: "repairer", unitId: "review-repair-2" },
      { role: "repairer", unitId: "review-repair-3" },
    ]);
    expect(runnerCalls.filter((call) => call.fn === "runCheckpointableAgent")).toHaveLength(5);
    // Baseline, post-implementation, and one re-verification per repair
    // pass. The call count pins the exact verification stages.
    expect(verifyCalls).toHaveLength(5);
    expect(state.reviewRouting?.outcome).toBe("human-fallback");
    // The bounded loop persisted every allowed pass's worker, gate, and
    // verification artifacts, each with passing verification...
    for (let pass = 1; pass <= 3; pass++) {
      expect(fakeStore?.written.has(`review-repair-${pass}.json`)).toBe(true);
      expect(fakeStore?.written.has(`review-repair-gate-${pass}.json`)).toBe(true);
      expect((fakeStore?.written.get(`verification-after-review-repair-${pass}.json`) as VerificationResult | undefined)?.passed).toBe(true);
    }
    // ...and the bounded loop stops exactly at the explicit limit: no fourth
    // pass.
    expect(fakeStore?.written.has("review-repair-4.json")).toBe(false);
    expect(fakeStore?.written.has("review-repair-gate-4.json")).toBe(false);
    expect(fakeStore?.written.has("verification-after-review-repair-4.json")).toBe(false);
    // The final (still rework) gate is persisted and drives the HUMAN routing.
    expect(fakeStore?.written.get("review-gate-after-repair-3.json")).toEqual(gate);
    // The persisted counters and routing agree with the returned state.
    const expectedCounters = {
      deterministicRepairPasses: state.deterministicRepairPasses,
      reviewRepairPasses: state.reviewRepairPasses,
      repairPasses: state.repairPasses,
    };
    const persistedState = persistedRunFacts("state.json");
    expect(persistedState).toMatchObject(expectedCounters);
    expect(persistedState?.reviewRouting).toEqual(state.reviewRouting);
    const runSummary = persistedRunFacts("run-summary.json");
    expect(runSummary).toMatchObject(expectedCounters);
    expect(runSummary?.reviewRouting).toEqual(state.reviewRouting);
    expect(fakeStore?.written.get("review-routing.json")).toEqual(state.reviewRouting);
  });

  it("runs zero repair assignments when both explicit budgets are zero, and reaches HUMAN through final-review routing", async () => {
    config.maxDeterministicRepairPasses = 0;
    config.maxReviewRepairPasses = 0;
    // Ordered verification outcomes: baseline pass, post-implementation fail
    // (drives the repair attempts). A confident rework cannot override the
    // zero budgets, so verification stops after the implementation stage; the
    // call count pins the exact verification stages.
    verificationSequence = [passingVerification(), failingVerification()];
    gate.action = "rework";
    const state = await run();
    expect(state.finalStatus).toBe("human");
    expect(state.deterministicRepairPasses).toBe(0);
    expect(state.reviewRepairPasses).toBe(0);
    expect(state.repairPasses).toBe(0);
    // Implementer assignments only: no repair assignments under the zero
    // budgets.
    expect(workerAssignments()).toEqual([
      { role: "implementer", unitId: "a" },
      { role: "implementer", unitId: "b" },
    ]);
    expect(runnerCalls.filter((call) => call.fn === "runCheckpointableAgent")).toHaveLength(2);
    // Baseline and post-implementation verification only.
    expect(verifyCalls).toHaveLength(2);
    // No repair worker, gate, or verification artifact exists in the run
    // store's written map.
    expect(fakeStore?.written.has("deterministic-repair-1.json")).toBe(false);
    expect(fakeStore?.written.has("review-repair-1.json")).toBe(false);
    expect(fakeStore?.written.has("verification-after-deterministic-repair-1.json")).toBe(false);
    expect(fakeStore?.written.has("verification-after-review-repair-1.json")).toBe(false);
    expect(state.telemetry?.some((stage) => stage.stage === "repairer")).toBe(false);
    expect(state.reviewRouting?.outcome).toBe("human-fallback");
    // The persisted counters remain zero.
    const persistedState = persistedRunFacts("state.json");
    expect(persistedState).toMatchObject({ deterministicRepairPasses: 0, reviewRepairPasses: 0, repairPasses: 0 });
    const runSummary = persistedRunFacts("run-summary.json");
    expect(runSummary).toMatchObject({ deterministicRepairPasses: 0, reviewRepairPasses: 0, repairPasses: 0 });
  });

  it("honors an explicit deterministic budget greater than one, counting repair assignments separately from implementation workers", async () => {
    config.maxDeterministicRepairPasses = 2;
    // Ordered verification outcomes: baseline pass, post-implementation fail
    // (drives the deterministic repair), repair 1 still fails, repair 2
    // restores. The call count pins the exact verification stages.
    verificationSequence = [
      passingVerification(), failingVerification(), failingVerification(), passingVerification(),
    ];
    const state = await run();
    expect(state.finalStatus).toBe("accepted");
    expect(state.deterministicRepairPasses).toBe(2);
    expect(state.reviewRepairPasses).toBe(0);
    expect(state.repairPasses).toBe(2);
    // Repair assignments are counted separately from implementation workers,
    // in execution order; no review repair is attempted.
    expect(workerAssignments()).toEqual([
      { role: "implementer", unitId: "a" },
      { role: "implementer", unitId: "b" },
      { role: "repairer", unitId: "verification-repair-1" },
      { role: "repairer", unitId: "verification-repair-2" },
    ]);
    expect(runnerCalls.filter((call) => call.fn === "runCheckpointableAgent")).toHaveLength(4);
    // Baseline, post-implementation, and one re-verification per repair pass.
    expect(verifyCalls).toHaveLength(4);
    // Repair 1 leaves the check failing; repair 2 restores it.
    expect((fakeStore?.written.get("verification-after-deterministic-repair-1.json") as VerificationResult | undefined)?.passed).toBe(false);
    expect((fakeStore?.written.get("verification-after-deterministic-repair-2.json") as VerificationResult | undefined)?.passed).toBe(true);
    // Only implementation workers contribute to state.workers; repair reports
    // are pass-scoped artifacts, not implementation evidence.
    expect(state.workers?.map((report) => report.unitId)).toEqual(["a", "b"]);
    expect(state.telemetry?.filter((stage) => stage.stage === "implementer")).toHaveLength(2);
    expect(state.telemetry?.filter((stage) => stage.stage === "repairer")).toHaveLength(2);
    // The bounded loop persisted every allowed pass's worker artifact...
    expect(fakeStore?.written.has("deterministic-repair-1.json")).toBe(true);
    expect(fakeStore?.written.has("deterministic-repair-2.json")).toBe(true);
    // ...and no review repair was attempted, while no third (next-pass)
    // worker, gate, or verification artifact exists.
    expect(fakeStore?.written.has("review-repair-1.json")).toBe(false);
    expect(fakeStore?.written.has("deterministic-repair-3.json")).toBe(false);
    expect(fakeStore?.written.has("deterministic-repair-gate-3.json")).toBe(false);
    expect(fakeStore?.written.has("verification-after-deterministic-repair-3.json")).toBe(false);
    // The default gate sufficiency stays below the normal-acceptance bound.
    expect(state.reviewRouting?.outcome).toBe("bounded-low-sufficiency-acceptance");
    // The persisted counters and routing agree with the returned state...
    const expectedCounters = {
      deterministicRepairPasses: state.deterministicRepairPasses,
      reviewRepairPasses: state.reviewRepairPasses,
      repairPasses: state.repairPasses,
    };
    const persistedState = persistedRunFacts("state.json");
    expect(persistedState).toMatchObject(expectedCounters);
    expect(persistedState?.reviewRouting).toEqual(state.reviewRouting);
    const runSummary = persistedRunFacts("run-summary.json");
    expect(runSummary).toMatchObject(expectedCounters);
    expect(runSummary?.reviewRouting).toEqual(state.reviewRouting);
    expect(fakeStore?.written.get("review-routing.json")).toEqual(state.reviewRouting);
    // ...and the persisted workers retain the implementation/repair
    // separation.
    const persistedWorkers = (fakeStore?.written.get("state.json") as { workers?: Array<{ unitId?: string }> } | undefined)?.workers;
    expect(persistedWorkers?.map((report) => report.unitId)).toEqual(["a", "b"]);
  });

  it.each([0.57, 0.65])("persists original scores and explicit acceptance routing at %s", async (probability) => {
    gate.reviewSufficientProbability = probability;
    const state = await run();
    expect(state.finalStatus).toBe("accepted");
    const outcome = probability === 0.57 ? "bounded-low-sufficiency-acceptance" : "normal-acceptance";
    expect(state.reviewRouting?.outcome).toBe(outcome);
    // The routing evidence echoes the original gate action, confidence, and
    // sufficiency probability against the configured default thresholds.
    expect(state.reviewRouting).toMatchObject({
      action: "accept",
      confidence: 1,
      reviewSufficientProbability: probability,
      minChoiceConfidence: DEFAULT_CONFIG.jev.minChoiceConfidence,
      minNoulProbability: DEFAULT_CONFIG.jev.minNoulProbability,
    });
    // The original Jev gate, including its raw score, is persisted unchanged.
    expect(fakeStore?.written.get("review-gate.json")).toEqual(gate);
    expect(fakeStore?.written.get("review-routing.json")).toEqual(state.reviewRouting);
    expect((fakeStore?.written.get("state.json") as { reviewGate?: ReviewGateDecision } | undefined)?.reviewGate).toEqual(gate);
    expect(persistedRunFacts("run-summary.json")?.reviewRouting).toEqual(state.reviewRouting);
    // The final routing decision is present and carries the full routing
    // evidence, including the expected outcome.
    const finalRoutingRecord = decisionsOf("final-review-routing").at(-1);
    expect(finalRoutingRecord).toBeDefined();
    expect(finalRoutingRecord?.routing).toEqual(state.reviewRouting);
    expect((finalRoutingRecord?.routing as { outcome?: string }).outcome).toBe(outcome);
    // The controller disposition is accepted-in-place; the fake transaction
    // records the accepted conclude flag.
    expect(state.sourceDisposition?.disposition).toBe("accepted-in-place");
    expect(fakeTransactions[0].concludeCalls).toEqual([
      { accepted: true, verifiedDiff: "", writerQuiescenceUncertain: false, ignoredPrefixes: [".pi/software-factory/runs"], retainedWorktrees: [] },
    ]);
  });

  it.each(["replan", "human"] as const)("preserves final %s semantics and persists human fallback", async (action) => {
    gate.action = action;
    const state = await run();
    expect(state.finalStatus).toBe("human");
    expect(state.deterministicRepairPasses).toBe(0);
    expect(state.reviewRepairPasses).toBe(0);
    expect(state.repairPasses).toBe(0);
    expect(state.reviewRouting?.outcome).toBe("human-fallback");
    // The original action is preserved in the persisted routing artifact.
    expect((fakeStore?.written.get("review-routing.json") as { action?: string } | undefined)?.action).toBe(action);
    // The persisted gate, state, and summary routing agree with the
    // returned state, and the final routing decision matches.
    expect(fakeStore?.written.get("review-gate.json")).toEqual(gate);
    expect(persistedRunFacts("state.json")?.reviewRouting).toEqual(state.reviewRouting);
    expect(persistedRunFacts("run-summary.json")?.reviewRouting).toEqual(state.reviewRouting);
    // The final routing decision is present and agrees with the returned
    // routing, including the human-fallback outcome.
    const finalRoutingRecord = decisionsOf("final-review-routing").at(-1);
    expect(finalRoutingRecord).toBeDefined();
    expect(finalRoutingRecord?.routing).toEqual(state.reviewRouting);
    expect((finalRoutingRecord?.routing as { outcome?: string }).outcome).toBe("human-fallback");
    // The fake transaction's established policy maps a non-accepted run to
    // unchanged (not the real fixture's retained-unaccepted), with
    // conclude accepted:false.
    expect(state.sourceDisposition?.disposition).toBe("unchanged");
    expect(fakeTransactions[0].concludeCalls).toEqual([
      { accepted: false, verifiedDiff: "", writerQuiescenceUncertain: false, ignoredPrefixes: [".pi/software-factory/runs"], retainedWorktrees: [] },
    ]);
  });

  it("uses non-default final thresholds in the actual controller", async () => {
    config.jev.minChoiceConfidence = 0.99;
    config.jev.minNoulProbability = 0.95;
    gate.confidence = 0.98;
    const state = await run();
    expect(state.finalStatus).toBe("human");
    expect(state.reviewRouting).toMatchObject({ outcome: "human-fallback", minChoiceConfidence: 0.99, minNoulProbability: 0.95 });
    // The persisted routing artifact and the final routing decision retain
    // the configured non-default thresholds.
    expect(fakeStore?.written.get("review-routing.json")).toEqual(state.reviewRouting);
    expect((decisionsOf("final-review-routing").at(-1)?.routing as { minChoiceConfidence?: number; minNoulProbability?: number; outcome?: string }))
      .toMatchObject({ outcome: "human-fallback", minChoiceConfidence: 0.99, minNoulProbability: 0.95 });
    // The non-accepted run concludes unchanged with accepted:false.
    expect(state.sourceDisposition?.disposition).toBe("unchanged");
    expect(fakeTransactions[0].concludeCalls).toEqual([
      { accepted: false, verifiedDiff: "", writerQuiescenceUncertain: false, ignoredPrefixes: [".pi/software-factory/runs"], retainedWorktrees: [] },
    ]);
  });
});
