import { execFile } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as agents from "../src/agent-runner.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { runFactory } from "../src/controller.js";
import { JevDecisionEngine } from "../src/jev.js";
import type { ArchitectureResult, FactoryConfig, FactoryRunState, ModelRef, ReviewGateDecision, ReviewResult, ScoutResult } from "../src/types.js";
import { makeCheckpointFixture, makeFakeModelRuntime, makeScoutResultFixture, makeWorkerReportFixture } from "./helpers/agent-runner-harness.js";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await exec("git", args, { cwd, windowsHide: true })).stdout;
}
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
let cwd: string;
let config: FactoryConfig;
let architecture: ArchitectureResult;
let review: ReviewResult;
let gate: ReviewGateDecision;
let writeWorker: (options: agents.RunCheckpointableAgentOptions<unknown>) => Promise<void>;
let workerCalls: number;
let workerAssignments: Array<{ kind: "implementation" | "deterministic-repair" | "review-repair"; unitId: string }>;
let reviewSequence: ReviewResult[];
let reviewCalls: number;
let runnerCalls: Array<{ fn: "runAgent" | "runCheckpointableAgent"; role: string; model: ModelRef }>;
let implementationPrompts: Array<{ unitId: string; prompt: string }> = [];
let scoutFactory: () => ScoutResult = () => makeScoutResultFixture();

/**
 * Extracts the embedded factory-input payload from an implementer prompt.
 * The prompt embeds `JSON.stringify(input, null, 2)` after a fixed anchor; we
 * locate the first `{` after the anchor and balance braces (string-aware) to
 * recover the exact serialized payload without depending on prompt layout.
 */
function extractFactoryInput(prompt: string): Record<string, any> {
  const anchor = "in this factory input:";
  const anchorIndex = prompt.indexOf(anchor);
  if (anchorIndex === -1) throw new Error("test: factory input anchor not found in prompt");
  const start = prompt.indexOf("{", anchorIndex);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < prompt.length; i += 1) {
    const ch = prompt[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error("test: unbalanced factory input braces in prompt");
  return JSON.parse(prompt.slice(start, end + 1)) as Record<string, any>;
}

const json = (dir: string, file: string) => JSON.parse(readFileSync(join(dir, file), "utf8"));
const runDir = (state: FactoryRunState) => join(cwd, config.runRoot, state.id);
const run = (signal?: AbortSignal) => runFactory(cwd, "fixture reliability change", config, () => {}, signal);
const workerId = (prompt: string) => /"currentUnit":\s*\{\s*"id": "([^"]+)"/.exec(prompt)?.[1] ?? "a";
const assignmentKind = (options: agents.RunCheckpointableAgentOptions<unknown>) =>
  options.role === "implementer"
    ? ("implementation" as const)
    : options.prompt.includes('"unitId": "verification-repair-')
      ? ("deterministic-repair" as const)
      : ("review-repair" as const);

/**
 * Restores the original a.txt/b.txt filesExpected scopes on the fresh fixture's
 * a/b units only. Opt-in for tests whose behavior is gated on scopes: parallel
 * batch selection, sequential scope snapshots, and unit-scoped scout evidence.
 */
const restoreDefaultUnitScopes = () => {
  for (const id of ["a", "b"]) {
    const unit = architecture.implementationUnits.find((candidate) => candidate.id === id);
    if (unit) unit.filesExpected = [`${id}.txt`];
  }
};

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), "pi-sf-controller-test-"));
  await git(cwd, "init", "-b", "main");
  await git(cwd, "config", "user.name", "Test");
  await git(cwd, "config", "user.email", "test@local.invalid");
  await git(cwd, "config", "commit.gpgsign", "false");
  await git(cwd, "config", "core.autocrlf", "false");
  writeFileSync(join(cwd, "a.txt"), "baseline a\n");
  writeFileSync(join(cwd, "b.txt"), "baseline b\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", "baseline");
  config = structuredClone(DEFAULT_CONFIG);
  config.parallelImplementation.enabled = false;
  architecture = {
    summary: "fixture", approach: "bounded", architecturalDecisions: [], risks: [], assumptions: [], verificationStrategy: [],
    implementationUnits: ["a", "b"].map((id) => ({ id, objective: id, acceptance: [], constraints: [], dependsOn: [] })),
  };
  review = { summary: "clean", verdict: "clean", findings: [], testGaps: [], requirementCoverage: [] };
  gate = { action: "accept", confidence: 1, residualRisk: "low", reviewSufficientProbability: 0.57, raw: { score: 0.57 } };
  workerCalls = 0;
  workerAssignments = [];
  implementationPrompts = [];
  scoutFactory = () => makeScoutResultFixture();
  reviewSequence = [review];
  reviewCalls = 0;
  runnerCalls = [];
  writeWorker = async (options) => {
    const id = workerId(options.prompt);
    writeFileSync(join(options.cwd, `${id}.txt`), `implemented ${id}\n`);
  };
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
    workerCalls++;
    await writeWorker(options);
    const id = workerId(options.prompt);
    const kind = assignmentKind(options);
    workerAssignments.push({ kind, unitId: id });
    if (kind === "implementation") implementationPrompts.push({ unitId: id, prompt: options.prompt });
    return { kind: "result", result: options.validate(makeWorkerReportFixture({ unitId: id, changedFiles: [`${id}.txt`] })), metrics: runnerMetrics(options.model) };
  });
});

async function removeFixtureWorktrees(repo: string) {
  const list = await git(repo, "worktree", "list", "--porcelain", "-z");
  for (const field of list.split("\0")) {
    if (!field.startsWith("worktree ")) continue;
    const dir = field.slice(9);
    // These git-init fixtures have a .git directory; only linked worktrees
    // have a .git file. Path spelling (including Windows aliases) is irrelevant.
    if (!lstatSync(join(dir, ".git")).isFile()) continue;
    await git(repo, "worktree", "remove", "--force", dir);
  }
}

afterEach(async () => {
  // Retained worktrees are intentional production evidence; tests own their repos.
  try {
    if (cwd) {
      await removeFixtureWorktrees(cwd);
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

describe("controller context handoff", () => {
  it("hands off distinct unit-scoped scout evidence into each sequential prompt and per-unit artifact without cross-unit leakage", async () => {
    scoutFactory = () => ({
      summary: "multi-unit scout",
      files: [
        { path: "a.txt", relevance: "file a" },
        { path: "b.txt", relevance: "file b" },
        { path: "shared/notes.txt", relevance: "shared" },
      ],
      symbols: [
        { name: "sym_a", path: "a.txt", relevance: "symbol a" },
        { name: "sym_b", path: "b.txt", relevance: "symbol b" },
        { name: "sym_shared", path: "shared/notes.txt", relevance: "symbol shared" },
      ],
      relationships: ["a.txt and b.txt are related"],
      constraints: ["keep deterministic"],
      tests: ["npm test"],
      unknowns: ["none"],
      recommendedReads: ["a.txt"],
    });
    restoreDefaultUnitScopes();
    const state = await run();
    expect(state.finalStatus, state.finalReason).toBe("accepted");

    for (const id of ["a", "b"]) {
      const artifact = json(runDir(state), `implementation-context-${id}.json`);
      expect(artifact.unitId).toBe(id);
      // The prompt payload carries the same selected evidence as the artifact.
      const payload = extractFactoryInput(implementationPrompts.find((p) => p.unitId === id)!.prompt);
      expect(payload.repositoryEvidence).toEqual(artifact.repositoryEvidence);
      // Every pre-existing prompt field is retained alongside the new evidence.
      for (const field of ["executionMode", "projectContext", "architectureSummary", "architecturalDecisions", "currentUnit", "otherUnits", "repositoryEvidence"]) {
        expect(payload).toHaveProperty(field);
      }
      // otherUnits still describes only the other unit; the current unit is not expanded into it.
      expect(payload.otherUnits).toHaveLength(1);
      expect(payload.otherUnits[0].id).toBe(id === "a" ? "b" : "a");
    }

    const aEvidence: ScoutResult = json(runDir(state), "implementation-context-a.json").repositoryEvidence;
    const bEvidence: ScoutResult = json(runDir(state), "implementation-context-b.json").repositoryEvidence;
    // Distinct, unit-scoped structured evidence.
    expect(aEvidence.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect(aEvidence.symbols.map((s) => s.name)).toEqual(["sym_a"]);
    expect(bEvidence.files.map((f) => f.path)).toEqual(["b.txt"]);
    expect(bEvidence.symbols.map((s) => s.name)).toEqual(["sym_b"]);
    // No cross-unit leakage of another unit's structured evidence.
    expect(aEvidence.files).not.toContainEqual(expect.objectContaining({ path: "b.txt" }));
    expect(aEvidence.symbols).not.toContainEqual(expect.objectContaining({ name: "sym_b" }));
    expect(bEvidence.files).not.toContainEqual(expect.objectContaining({ path: "a.txt" }));
    expect(bEvidence.symbols).not.toContainEqual(expect.objectContaining({ name: "sym_a" }));
    // Free-text fields lack structured path metadata and are always retained.
    expect(aEvidence.relationships).toEqual(["a.txt and b.txt are related"]);
    expect(aEvidence.summary).toBe("multi-unit scout");
  });

  it("uses merged rescout evidence (not the earlier scout snapshot) for implementation context", async () => {
    let scoutCalls = 0;
    scoutFactory = () => {
      scoutCalls += 1;
      return scoutCalls === 1
        ? {
            summary: "base scout",
            files: [{ path: "a.txt", relevance: "base a" }],
            symbols: [{ name: "sym_a", path: "a.txt", relevance: "base symbol" }],
            relationships: [], constraints: [], tests: [], unknowns: ["need b"], recommendedReads: [],
          }
        : {
            summary: "supplemental",
            files: [{ path: "b.txt", relevance: "rescout b" }],
            symbols: [{ name: "sym_b", path: "b.txt", relevance: "rescout symbol" }],
            relationships: [], constraints: [], tests: [], unknowns: [], recommendedReads: [],
          };
    };
    vi.mocked(JevDecisionEngine.prototype.gatePlan).mockResolvedValueOnce({
      action: "rescout", confidence: 1, planCompleteProbability: 1, implementationRisk: "low", rescoutFocus: "dependencies", replanFocus: "none", raw: {},
    });
    restoreDefaultUnitScopes();
    const state = await run();
    expect(state.finalStatus, state.finalReason).toBe("accepted");
    expect(scoutCalls).toBeGreaterThanOrEqual(2);
    // b.txt exists only in the rescout supplemental, so its presence in unit b's
    // evidence proves the merged scout is consumed, not the earlier base snapshot.
    const bEvidence: ScoutResult = json(runDir(state), "implementation-context-b.json").repositoryEvidence;
    expect(bEvidence.files.map((f) => f.path)).toEqual(["b.txt"]);
    expect(bEvidence.symbols.map((s) => s.name)).toEqual(["sym_b"]);
    expect(bEvidence.summary).toContain("supplemental");
    // The merged-evidence artifact matches the prompt payload for the unit.
    const payload = extractFactoryInput(implementationPrompts.find((p) => p.unitId === "b")!.prompt);
    expect(payload.repositoryEvidence).toEqual(bEvidence);
  });

  it("retains the unit-scoped evidence across a checkpointed fresh implementation worker session", async () => {
    config.models = structuredClone(roleModels);
    scoutFactory = () => ({
      summary: "checkpoint scout",
      files: [{ path: "a.txt", relevance: "file a" }, { path: "b.txt", relevance: "file b" }],
      symbols: [{ name: "sym_a", path: "a.txt", relevance: "a" }, { name: "sym_b", path: "b.txt", relevance: "b" }],
      relationships: [], constraints: [], tests: [], unknowns: [], recommendedReads: [],
    });
    let implementationSegments = 0;
    vi.mocked(agents.runCheckpointableAgent).mockImplementation(async (options) => {
      runnerCalls.push({ fn: "runCheckpointableAgent", role: options.role, model: options.model });
      workerCalls += 1;
      const kind = assignmentKind(options);
      await writeWorker(options);
      const id = workerId(options.prompt);
      workerAssignments.push({ kind, unitId: id });
      if (kind === "implementation") implementationPrompts.push({ unitId: id, prompt: options.prompt });
      if (kind === "implementation" && implementationSegments === 0) {
        implementationSegments += 1;
        // The first implementation segment (unit a) ends in a checkpoint; the
        // resumed fresh session is a new runCheckpointableAgent call.
        return { kind: "checkpoint", checkpoint: makeCheckpointFixture({ unitId: id }), context: { tokens: 70_000, contextWindow: 100_000, percent: 70 }, metrics: runnerMetrics(options.model) };
      }
      return { kind: "result", result: options.validate(makeWorkerReportFixture({ unitId: id, changedFiles: [`${id}.txt`] })), metrics: runnerMetrics(options.model) };
    });
    restoreDefaultUnitScopes();
    const state = await run();
    expect(state.finalStatus, state.finalReason).toBe("accepted");
    // Unit a produced two implementation segments (initial + resumed); unit b one.
    const aPrompts = implementationPrompts.filter((p) => p.unitId === "a");
    expect(aPrompts).toHaveLength(2);
    const artifact = json(runDir(state), "implementation-context-a.json");
    const aEvidence: ScoutResult = artifact.repositoryEvidence;
    expect(artifact.unitId).toBe("a");
    expect(aEvidence.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect(aEvidence.symbols.map((s) => s.name)).toEqual(["sym_a"]);
    // The same selected evidence survives the fresh resumed session and matches the artifact.
    for (const { prompt } of aPrompts) {
      expect(extractFactoryInput(prompt).repositoryEvidence).toEqual(aEvidence);
    }
    // All three implementation segments (unit a original, unit a resumed,
    // unit b) resolved the implementer role's ModelRef.
    const implementerCalls = runnerCalls.filter((call) => call.fn === "runCheckpointableAgent" && call.role === "implementer");
    expect(implementerCalls).toEqual([
      { fn: "runCheckpointableAgent", role: "implementer", model: roleModels.implementer },
      { fn: "runCheckpointableAgent", role: "implementer", model: roleModels.implementer },
      { fn: "runCheckpointableAgent", role: "implementer", model: roleModels.implementer },
    ]);
    expect(state.telemetry?.filter((stage) => stage.stage === "implementer").map((stage) => [stage.stage, stage.actor, stage.model, stage.outcome])).toEqual([
      ["implementer", "agent", "prov-implementer/model-implementer", "completed"],
      ["implementer", "agent", "prov-implementer/model-implementer", "completed"],
      ["implementer", "agent", "prov-implementer/model-implementer", "completed"],
    ]);
  });

  it("retains the unit-scoped evidence across a Jev-continuation fresh implementation worker session", async () => {
    config.models = structuredClone(roleModels);
    scoutFactory = () => ({
      summary: "continuation scout",
      files: [{ path: "a.txt", relevance: "file a" }, { path: "b.txt", relevance: "file b" }],
      symbols: [{ name: "sym_a", path: "a.txt", relevance: "a" }, { name: "sym_b", path: "b.txt", relevance: "b" }],
      relationships: [], constraints: [], tests: [], unknowns: [], recommendedReads: [],
    });
    let workerGates = 0;
    vi.mocked(JevDecisionEngine.prototype.gateWorker).mockImplementation(async () => {
      workerGates += 1;
      // Only the first gate (unit a's initial report) requests a continuation;
      // the resumed fresh session and unit b both resolve ready.
      return workerGates === 1
        ? { disposition: "continue", confidence: 1, raw: {} }
        : { disposition: "ready", confidence: 1, raw: {} };
    });
    restoreDefaultUnitScopes();
    const state = await run();
    expect(state.finalStatus, state.finalReason).toBe("accepted");
    // Unit a produced two implementation segments (initial + Jev continuation).
    const aPrompts = implementationPrompts.filter((p) => p.unitId === "a");
    expect(aPrompts).toHaveLength(2);
    expect(state.workerContinuations).toHaveLength(1);
    const artifact = json(runDir(state), "implementation-context-a.json");
    const aEvidence: ScoutResult = artifact.repositoryEvidence;
    expect(artifact.unitId).toBe("a");
    expect(aEvidence.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect(aEvidence.symbols.map((s) => s.name)).toEqual(["sym_a"]);
    // The same selected evidence survives the fresh continuation session and matches the artifact.
    for (const { prompt } of aPrompts) {
      expect(extractFactoryInput(prompt).repositoryEvidence).toEqual(aEvidence);
    }
    // All three implementation segments (unit a original, unit a Jev-continued,
    // unit b) resolved the implementer role's ModelRef.
    const implementerCalls = runnerCalls.filter((call) => call.fn === "runCheckpointableAgent" && call.role === "implementer");
    expect(implementerCalls).toEqual([
      { fn: "runCheckpointableAgent", role: "implementer", model: roleModels.implementer },
      { fn: "runCheckpointableAgent", role: "implementer", model: roleModels.implementer },
      { fn: "runCheckpointableAgent", role: "implementer", model: roleModels.implementer },
    ]);
    expect(state.telemetry?.filter((stage) => stage.stage === "implementer").map((stage) => [stage.stage, stage.actor, stage.model, stage.outcome])).toEqual([
      ["implementer", "agent", "prov-implementer/model-implementer", "completed"],
      ["implementer", "agent", "prov-implementer/model-implementer", "completed"],
      ["implementer", "agent", "prov-implementer/model-implementer", "completed"],
    ]);
  });

  it("hands off distinct unit-scoped evidence per parallel unit without changing scheduling or worktree behavior", async () => {
    config.parallelImplementation.enabled = true;
    restoreDefaultUnitScopes();
    scoutFactory = () => ({
      summary: "parallel scout",
      files: [{ path: "a.txt", relevance: "a" }, { path: "b.txt", relevance: "b" }],
      symbols: [{ name: "sym_a", path: "a.txt", relevance: "a" }, { name: "sym_b", path: "b.txt", relevance: "b" }],
      relationships: [], constraints: [], tests: [], unknowns: [], recommendedReads: [],
    });
    const state = await run();
    expect(state.finalStatus, state.finalReason).toBe("accepted");
    // Scheduling and worktree behavior are unchanged.
    expect(json(runDir(state), "parallel-batch-1.json").outcome).toBe("integrated");
    expect(readdirSync(runDir(state)).filter((file) => file.startsWith("parallel-change-"))).toHaveLength(2);
    // Per-unit prompt/artifact identity with distinct, unit-scoped evidence.
    for (const id of ["a", "b"]) {
      const artifact = json(runDir(state), `implementation-context-${id}.json`);
      const evidence: ScoutResult = artifact.repositoryEvidence;
      expect(artifact.unitId).toBe(id);
      expect(evidence.files.map((f) => f.path)).toEqual([`${id}.txt`]);
      expect(evidence.symbols.map((s) => s.name)).toEqual([`sym_${id}`]);
      const payload = extractFactoryInput(implementationPrompts.find((p) => p.unitId === id)!.prompt);
      expect(payload.repositoryEvidence).toEqual(evidence);
    }
  });

}, 30_000);
