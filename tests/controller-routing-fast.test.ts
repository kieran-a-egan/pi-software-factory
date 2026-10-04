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
  FactoryProgressEvent,
  ModelRef,
  ReviewGateDecision,
  ReviewResult,
  ScoutResult,
  VerificationResult,
} from "../src/types.js";
import { makeFakeModelRuntime, makeScoutResultFixture, makeWorkerReportFixture } from "./helpers/agent-runner-harness.js";

/**
 * Fast, in-memory port of the four role-routing tests from
 * tests/controller-reliability.test.ts. The real runFactory() controller flow
 * (routing, Jev gate wiring, telemetry, counters, progress events, model
 * resolution) runs unmodified; only the four infrastructure boundaries are
 * replaced with local typed doubles:
 *   - createRunStore  -> in-memory RunStore (path-shaped dir, JSON round-trips)
 *   - reserveRun      -> no-op source transaction with recorded call surface
 *   - gitStatus       -> "" (clean tree, no Git subprocess)
 *   - verify          -> fresh passing VerificationResult (no shell commands)
 * plus the established JevDecisionEngine prototype, ModelRuntime.create, and
 * agent-runner mocks. No Git repository is initialized, no source snapshots or
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

/** Unit id embedded in the real implementer prompt's serialized factory input. */
const workerId = (prompt: string) => /"currentUnit":\s*\{\s*"id": "([^"]+)"/.exec(prompt)?.[1] ?? "a";

/** Fresh passing verification evidence; diff is a string because doReview slices it. */
const passingVerification = (): VerificationResult => ({
  passed: true,
  checks: [],
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
 * Local reserveRun double: active evidence, a no-op begin, a deterministic
 * conclude returning accepted-in-place evidence for the accepted fixture runs,
 * and a no-op release. Performs no source capture or lock operations, and
 * records every call so the harness can confirm the controller traversed it.
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
      return { ...evidence, disposition: "accepted-in-place" };
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
    return passingVerification();
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
    const id = workerId(options.prompt);
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
});
