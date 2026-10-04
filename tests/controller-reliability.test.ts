import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as agents from "../src/agent-runner.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { runFactory } from "../src/controller.js";
import * as gitEvidence from "../src/git-evidence.js";
import { JevDecisionEngine } from "../src/jev.js";
import * as prompts from "../src/prompts.js";
import { reserveRun } from "../src/run-safety.js";
import { createRunStore } from "../src/storage.js";
import { gitStatus } from "../src/verification.js";
import type { ArchitectureResult, FactoryConfig, FactoryProgressEvent, FactoryRunState, ModelRef, ReviewGateDecision, ReviewResult, ScoutResult } from "../src/types.js";
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
let originalHead: string;
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
const lockPath = () => join(cwd, ".git", "pi-software-factory.lock");
const run = (signal?: AbortSignal) => runFactory(cwd, "fixture reliability change", config, () => {}, signal);
const workerId = (prompt: string) => /"currentUnit":\s*\{\s*"id": "([^"]+)"/.exec(prompt)?.[1] ?? "a";
const assignmentKind = (options: agents.RunCheckpointableAgentOptions<unknown>) =>
  options.role === "implementer"
    ? ("implementation" as const)
    : options.prompt.includes('"unitId": "verification-repair-')
      ? ("deterministic-repair" as const)
      : ("review-repair" as const);
const assignmentsOf = (kind: "implementation" | "deterministic-repair" | "review-repair") =>
  workerAssignments.filter((assignment) => assignment.kind === kind).length;
const decisionsOf = (state: FactoryRunState, stage: string) =>
  readFileSync(join(runDir(state), "decisions.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    .filter((decision) => decision.stage === stage);

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
  originalHead = await git(cwd, "rev-parse", "HEAD");
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

describe("controller release reliability", () => {
  it("cleanup preserves an aliased main checkout and removes dirty linked worktrees with spaced Unicode paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sf-cleanup test-"));
    const alias = join(root, "main alias");
    const linkedRoot = join(root, "linked données 雪");
    const linked = join(linkedRoot, "repo with spaces");
    try {
      symlinkSync(cwd, alias, process.platform === "win32" ? "junction" : "dir");
      mkdirSync(linkedRoot);
      await git(cwd, "worktree", "add", "--detach", linked, "HEAD");
      writeFileSync(join(linked, "a.txt"), "retained edit\n");
      writeFileSync(join(linked, "untracked.txt"), "retained untracked\n");

      await removeFixtureWorktrees(alias);

      expect(await git(alias, "rev-parse", "HEAD")).toBe(originalHead);
      expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("baseline a\n");
      expect(await git(alias, "status", "--porcelain")).toBe("");
      expect(existsSync(linked)).toBe(false);
      expect((await git(alias, "worktree", "list", "--porcelain", "-z")).split("\0")
        .filter((field) => field.startsWith("worktree "))).toHaveLength(1);
    } finally {
      // Also clean up if a regression prevents the helper from removing the link.
      if (existsSync(linked)) await git(cwd, "worktree", "remove", "--force", linked);
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it.each([0.57, 0.65])("persists original scores and explicit acceptance routing at %s", async (probability) => {
    gate.reviewSufficientProbability = probability;
    const state = await run();
    expect(state.finalStatus).toBe("accepted");
    const outcome = probability === 0.57 ? "bounded-low-sufficiency-acceptance" : "normal-acceptance";
    expect(state.reviewRouting?.outcome).toBe(outcome);
    expect(json(runDir(state), "review-gate.json")).toEqual(gate);
    expect(json(runDir(state), "review-routing.json")).toEqual(state.reviewRouting);
    expect(json(runDir(state), "state.json").reviewGate).toEqual(gate);
    expect(json(runDir(state), "run-summary.json").reviewRouting).toEqual(state.reviewRouting);
    const decisions = readFileSync(join(runDir(state), "decisions.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(decisions.at(-1).routing.outcome).toBe(outcome);
    expect(state.sourceDisposition?.disposition).toBe("accepted-in-place");
    expect(existsSync(lockPath())).toBe(false);
    expect(await git(cwd, "rev-parse", "HEAD")).toBe(originalHead);
    expect(await git(cwd, "diff", "--cached")).toBe("");
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("implemented a\n");
    expect(readFileSync(join(cwd, "b.txt"), "utf8")).toBe("implemented b\n");
  });

  it("retains partial sequential edits on HUMAN, and blocks another run even with clean-tree checking disabled", async () => {
    vi.mocked(JevDecisionEngine.prototype.gateWorker).mockResolvedValueOnce({ disposition: "ready", confidence: 1, raw: {} })
      .mockResolvedValueOnce({ disposition: "blocked", confidence: 1, raw: {} });
    const state = await run();
    expect(workerCalls).toBe(2);
    expect(state.finalStatus).toBe("human");
    expect(state.sourceDisposition?.disposition).toBe("retained-unaccepted");
    expect(json(runDir(state), "source-before.json").diff).toBe("");
    expect(json(runDir(state), "source-after.json").diff).toContain("implemented a");
    expect(json(runDir(state), "source-after.json").diff).toContain("implemented b");
    expect(existsSync(lockPath())).toBe(true);
    config.requireCleanWorkingTree = false;
    const blocked = await run();
    expect(blocked.id).not.toBe(state.id);
    expect(blocked.finalStatus).toBe("blocked");
    expect(blocked.finalReason).toContain("source safety interlock");
    expect(workerCalls).toBe(2);
    expect(json(runDir(state), "state.json").finalStatus).toBe("human");
    expect(await git(cwd, "rev-parse", "HEAD")).toBe(originalHead);
  });

  it("persists FAILED and retains edits when a later worker throws", async () => {
    writeWorker = async (options) => {
      writeFileSync(join(options.cwd, workerCalls === 1 ? "a.txt" : "b.txt"), "partial implementation\n");
      if (workerCalls === 2) throw new Error("injected worker failure");
    };
    const state = await run();
    expect(state.finalStatus).toBe("failed");
    expect(state.finalReason).toContain("injected worker failure");
    expect(state.sourceDisposition?.disposition).toBe("unknown-retained");
    expect(json(runDir(state), "state.json").finalStatus).toBe("failed");
    expect(json(runDir(state), "source-after.json").diff).toContain("partial implementation");
    expect(existsSync(lockPath())).toBe(true);
  });

  it("retains cancellation evidence and never treats partial work as accepted", async () => {
    const abort = new AbortController();
    writeWorker = async (options) => {
      writeFileSync(join(options.cwd, "a.txt"), "cancelled partial\n");
      expect(options.abortSignal).toBe(abort.signal);
      abort.abort();
    };
    const state = await run(abort.signal);
    expect(state.finalStatus).toBe("human");
    expect(state.finalReason).toContain("cancelled");
    expect(state.sourceDisposition?.disposition).toBe("unknown-retained");
    expect(workerCalls).toBe(1);
    expect(existsSync(lockPath())).toBe(true);
    expect(json(runDir(state), "source-after.json").diff).toContain("cancelled partial");
  });

  it.each(["replan", "human"] as const)("preserves final %s semantics and persists human fallback", async (action) => {
    gate.action = action;
    const state = await run();
    expect(state.finalStatus).toBe("human");
    expect(state.deterministicRepairPasses).toBe(0);
    expect(state.reviewRepairPasses).toBe(0);
    expect(state.repairPasses).toBe(0);
    expect(state.reviewRouting?.outcome).toBe("human-fallback");
    expect(json(runDir(state), "review-routing.json").action).toBe(action);
    expect(state.sourceDisposition?.disposition).toBe("retained-unaccepted");
  });

  it("persists one review repair with re-verification and final routing under the independent review budget", async () => {
    vi.mocked(JevDecisionEngine.prototype.gateReview).mockResolvedValueOnce({ ...gate, action: "rework" });
    const state = await run();
    expect(state.finalStatus).toBe("accepted");
    expect(state.deterministicRepairPasses).toBe(0);
    expect(state.reviewRepairPasses).toBe(1);
    expect(state.repairPasses).toBe(1);
    expect(workerCalls).toBe(3);
    expect(json(runDir(state), "verification-after-review-repair-1.json").passed).toBe(true);
    expect(json(runDir(state), "review-after-repair-1.json")).toEqual(review);
    expect(json(runDir(state), "review-gate-after-repair-1.json")).toEqual(gate);
    const decisions = readFileSync(join(runDir(state), "decisions.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(decisions.find((d) => d.stage === "worker-gate" && d.repairClass === "review"))
      .toMatchObject({ stage: "worker-gate", phase: "repair", repairClass: "review", repairPass: 1 });
    expect(decisions.find((d) => d.stage === "review-gate" && d.repairClass === "review"))
      .toMatchObject({ stage: "review-gate", repairClass: "review", repairPass: 1 });
  });

  it("forwards the immediately preceding review, latest repair report, and fresh post-repair verification into the second review", async () => {
    const firstReview: ReviewResult = {
      summary: "changes requested",
      verdict: "changes_requested",
      findings: [{ severity: "minor", title: "Unreadable error text", explanation: "The implementation in a.txt does not surface a readable error for a failed read.", file: "a.txt", suggestedFix: "Rephrase the error message." }],
      testGaps: [], requirementCoverage: [],
    };
    const cleanReview: ReviewResult = { summary: "clean after repair", verdict: "clean", findings: [], testGaps: [], requirementCoverage: [] };
    reviewSequence = [firstReview, cleanReview];
    vi.mocked(JevDecisionEngine.prototype.gateReview).mockResolvedValueOnce({ ...gate, action: "rework" });
    // The single review repair performs a small, newline-terminated edit so the
    // post-repair diff is distinguishable from the initial diff.
    writeWorker = async (options) => {
      if (assignmentKind(options) === "review-repair") {
        writeFileSync(join(options.cwd, "a.txt"), "repaired after review\n");
      } else {
        const id = workerId(options.prompt);
        writeFileSync(join(options.cwd, `${id}.txt`), `implemented ${id}\n`);
      }
    };
    const reviewerSpy = vi.spyOn(prompts, "reviewerPrompt");

    const state = await run();

    expect(state.finalStatus).toBe("accepted");
    expect(state.reviewRepairPasses).toBe(1);
    expect(state.deterministicRepairPasses).toBe(0);
    expect(reviewCalls).toBe(2);
    expect(assignmentsOf("review-repair")).toBe(1);
    expect(assignmentsOf("deterministic-repair")).toBe(0);

    const inputs = reviewerSpy.mock.calls.map((call) => call[0] as Record<string, any>);
    expect(inputs).toHaveLength(2);

    // The initial review carries no repair context at all.
    expect(inputs[0]).not.toHaveProperty("reviewRepair");

    // The second review carries the preceding review, the repair report, and the
    // fresh post-repair verification, all structurally equal to the persisted
    // evidence (the controller copies verification into the reviewer payload).
    expect(inputs[1].reviewRepair.previousReview).toEqual(firstReview);
    expect(inputs[1].reviewRepair.previousReview).toEqual(json(runDir(state), "review.json"));
    expect(inputs[1].reviewRepair.repair).toEqual(json(runDir(state), "review-repair-1.json"));
    const postRepairVerification = json(runDir(state), "verification-after-review-repair-1.json");
    expect(postRepairVerification.passed).toBe(true);
    expect(inputs[1].verification).toEqual(postRepairVerification);

    // The repair-specific edit makes the forwarded verification differ from the
    // initial one, so forwarding a stale verification would fail this assertion.
    expect(inputs[1].verification).not.toEqual(inputs[0].verification);
    expect(inputs[1].verification.diff).not.toBe(inputs[0].verification.diff);
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
    // Exactly two review repair assignments; the deterministic budget is untouched.
    expect(assignmentsOf("review-repair")).toBe(2);
    expect(assignmentsOf("deterministic-repair")).toBe(0);
    expect(state.reviewRepairPasses).toBe(2);
    expect(state.deterministicRepairPasses).toBe(0);
    expect(state.repairPasses).toBe(2);
    expect(workerCalls).toBe(4);
    // Passing re-verification after each repair.
    expect(json(runDir(state), "verification-after-review-repair-1.json").passed).toBe(true);
    expect(json(runDir(state), "verification-after-review-repair-2.json").passed).toBe(true);
    // Both post-repair review and gate artifacts exist with the expected content.
    expect(json(runDir(state), "review-after-repair-1.json")).toEqual(secondReview);
    expect(json(runDir(state), "review-after-repair-2.json")).toEqual(cleanReview);
    expect(json(runDir(state), "review-gate-after-repair-1.json")).toMatchObject({ action: "rework" });
    expect(json(runDir(state), "review-gate-after-repair-2.json")).toMatchObject({ action: "accept" });
    // Decision history identifies class and pass for the review class and
    // preserves the final routing evidence.
    const decisions = decisionsOf(state, "worker-gate").filter((d) => d.repairClass === "review");
    expect(decisions.map((d) => d.repairPass)).toEqual([1, 2]);
    const reviewGates = decisionsOf(state, "review-gate").filter((d) => d.repairClass === "review");
    expect(reviewGates.map((d) => [d.repairPass, d.decision.action])).toEqual([[1, "rework"], [2, "accept"]]);
    const routing = decisionsOf(state, "final-review-routing");
    expect(routing).toHaveLength(1);
    expect(routing[0].routing.outcome).toBe("normal-acceptance");
  });

  it("stops at the default review repair budget after exactly two review repairs, creates no next-pass artifact, and reaches HUMAN through final-review routing", async () => {
    gate.action = "rework";
    const state = await run();
    expect(state.finalStatus).toBe("human");
    expect(state.deterministicRepairPasses).toBe(0);
    expect(state.reviewRepairPasses).toBe(DEFAULT_CONFIG.maxReviewRepairPasses);
    expect(state.repairPasses).toBe(DEFAULT_CONFIG.maxReviewRepairPasses);
    expect(assignmentsOf("review-repair")).toBe(DEFAULT_CONFIG.maxReviewRepairPasses);
    expect(assignmentsOf("deterministic-repair")).toBe(0);
    expect(workerCalls).toBe(2 + DEFAULT_CONFIG.maxReviewRepairPasses);
    expect(state.reviewRouting?.outcome).toBe("human-fallback");
    const files = readdirSync(runDir(state));
    for (let pass = 1; pass <= DEFAULT_CONFIG.maxReviewRepairPasses; pass++) {
      expect(files).toContain(`review-repair-${pass}.json`);
      expect(files).toContain(`review-repair-gate-${pass}.json`);
      expect(files).toContain(`verification-after-review-repair-${pass}.json`);
    }
    // No third (next-pass) worker, gate, or verification artifact exists.
    expect(files).not.toContain("review-repair-3.json");
    expect(files).not.toContain("review-repair-gate-3.json");
    expect(files).not.toContain("verification-after-review-repair-3.json");
    expect(json(runDir(state), "run-summary.json").reviewRouting).toEqual(state.reviewRouting);
  });

  it("honors an explicit non-default review repair budget, creating no next-pass artifact and reaching HUMAN through final-review routing", async () => {
    config.maxReviewRepairPasses = 3;
    gate.action = "rework";
    const state = await run();
    expect(state.finalStatus).toBe("human");
    expect(state.deterministicRepairPasses).toBe(0);
    expect(state.reviewRepairPasses).toBe(3);
    expect(state.repairPasses).toBe(3);
    expect(assignmentsOf("review-repair")).toBe(3);
    expect(workerCalls).toBe(2 + 3);
    expect(state.reviewRouting?.outcome).toBe("human-fallback");
    const files = readdirSync(runDir(state));
    for (let pass = 1; pass <= 3; pass++) {
      expect(files).toContain(`review-repair-${pass}.json`);
      expect(files).toContain(`review-repair-gate-${pass}.json`);
      expect(files).toContain(`verification-after-review-repair-${pass}.json`);
    }
    // The bounded loop must stop exactly at the explicit limit: no fourth pass.
    expect(files).not.toContain("review-repair-4.json");
    expect(files).not.toContain("review-repair-gate-4.json");
    expect(files).not.toContain("verification-after-review-repair-4.json");
    // The final (still rework) gate is persisted and drives the HUMAN routing.
    expect(json(runDir(state), "review-gate-after-repair-3.json")).toEqual(gate);
    expect(json(runDir(state), "review-routing.json")).toEqual(state.reviewRouting);
    expect(json(runDir(state), "run-summary.json").reviewRouting).toEqual(state.reviewRouting);
  });

  it("accepts after one deterministic repair restores verification and two later review repairs, with both classes' pass-1 evidence coexisting", async () => {
    const check = 'node -e "process.exit(require(\'fs\').readFileSync(\'a.txt\',\'utf8\').startsWith(\'good\')?0:1)"';
    config.verificationCommands = [check];
    // Baseline passes: a.txt already carries the "good" prefix.
    writeFileSync(join(cwd, "a.txt"), "good baseline\n");
    await git(cwd, "add", "a.txt");
    await git(cwd, "commit", "-m", "good baseline");
    writeWorker = async (options) => {
      const kind = assignmentKind(options);
      if (kind === "implementation") {
        const id = workerId(options.prompt);
        // Unit a's implementation deliberately breaks the deterministic check.
        writeFileSync(join(options.cwd, `${id}.txt`), id === "a" ? "bad implementation\n" : `implemented b\n`);
      } else if (kind === "deterministic-repair") {
        writeFileSync(join(options.cwd, "a.txt"), "good after deterministic repair\n");
      } else {
        writeFileSync(join(options.cwd, "b.txt"), "review repaired\n");
      }
    };
    const requested: ReviewResult = { summary: "changes requested", verdict: "changes_requested", findings: [{ severity: "minor", title: "Inconsistent naming", explanation: "b.txt content is inconsistent with the objective.", file: "b.txt" }], testGaps: [], requirementCoverage: [] };
    const cleanReview: ReviewResult = { summary: "clean", verdict: "clean", findings: [], testGaps: [], requirementCoverage: [] };
    reviewSequence = [requested, requested, cleanReview];
    gate.reviewSufficientProbability = 0.65; // normal acceptance, not the low-sufficiency bound
    vi.mocked(JevDecisionEngine.prototype.gateReview)
      .mockResolvedValueOnce({ ...gate, action: "rework" })
      .mockResolvedValueOnce({ ...gate, action: "rework" })
      .mockResolvedValueOnce({ ...gate, action: "accept" });

    const state = await run();

    // Baseline passed, post-implementation verification failed, and the single
    // deterministic repair restored passing verification before initial review.
    expect(state.baselineVerification?.passed).toBe(true);
    expect(json(runDir(state), "verification.json").passed).toBe(false);
    expect(json(runDir(state), "verification-after-deterministic-repair-1.json").passed).toBe(true);
    // Dedicated counts 1 and 2, total 3, and acceptance.
    expect(state.deterministicRepairPasses).toBe(1);
    expect(state.reviewRepairPasses).toBe(2);
    expect(state.repairPasses).toBe(3);
    expect(state.finalStatus).toBe("accepted");
    expect(state.reviewRouting?.outcome).toBe("normal-acceptance");
    expect(assignmentsOf("deterministic-repair")).toBe(1);
    expect(assignmentsOf("review-repair")).toBe(2);
    expect(workerCalls).toBe(5);
    // The remaining two review repairs stayed available after deterministic
    // repair; both re-verified passing.
    expect(json(runDir(state), "verification-after-review-repair-1.json").passed).toBe(true);
    expect(json(runDir(state), "verification-after-review-repair-2.json").passed).toBe(true);
    // Both classes' pass-1 worker, gate, and verification artifacts coexist.
    const files = readdirSync(runDir(state));
    for (const stem of [
      "deterministic-repair-1",
      "deterministic-repair-gate-1",
      "verification-after-deterministic-repair-1",
      "review-repair-1",
      "review-repair-gate-1",
      "verification-after-review-repair-1",
    ]) {
      expect(files).toContain(`${stem}.json`);
    }
    // Content: worker reports, gate decisions, and the repaired verification.
    expect(json(runDir(state), "deterministic-repair-1.json")).toMatchObject({ summary: expect.any(String), changedFiles: ["a.txt"] });
    expect(json(runDir(state), "deterministic-repair-gate-1.json")).toMatchObject({ disposition: "ready" });
    expect(json(runDir(state), "review-repair-1.json")).toMatchObject({ changedFiles: ["a.txt"] });
    expect(json(runDir(state), "review-repair-gate-1.json")).toMatchObject({ disposition: "ready" });
    // Decision history identifies class and pass for both repair classes and
    // preserves the final routing evidence.
    const deterministicWorkerGates = decisionsOf(state, "worker-gate").filter((d) => d.repairClass === "deterministic");
    expect(deterministicWorkerGates.map((d) => d.repairPass)).toEqual([1]);
    expect(deterministicWorkerGates[0].decision.disposition).toBe("ready");
    const reviewWorkerGates = decisionsOf(state, "worker-gate").filter((d) => d.repairClass === "review");
    expect(reviewWorkerGates.map((d) => d.repairPass)).toEqual([1, 2]);
    const reviewGates = decisionsOf(state, "review-gate").filter((d) => d.repairClass === "review");
    expect(reviewGates.map((d) => [d.repairPass, d.decision.action])).toEqual([[1, "rework"], [2, "accept"]]);
    const routing = decisionsOf(state, "final-review-routing");
    expect(routing).toHaveLength(1);
    expect(routing[0].routing.outcome).toBe("normal-acceptance");
    // Aggregate telemetry and persisted summary carry both counters and the sum.
    expect(json(runDir(state), "run-summary.json")).toMatchObject({ deterministicRepairPasses: 1, reviewRepairPasses: 2, repairPasses: 3 });
    expect(json(runDir(state), "state.json")).toMatchObject({ deterministicRepairPasses: 1, reviewRepairPasses: 2, repairPasses: 3 });
  });

  it.each([
    { minChoiceConfidence: 0.6, confidence: 0.59 }, // just below the production default boundary
    { minChoiceConfidence: 0.9, confidence: 0.89 }, // explicit non-default boundary; production defaults are untouched
  ])("low action confidence below %s (confidence %s) still prevents rework with zero review repairs", async ({ minChoiceConfidence, confidence }) => {
    config.jev.minChoiceConfidence = minChoiceConfidence;
    gate.action = "rework";
    gate.confidence = confidence;
    const state = await run();
    expect(state.finalStatus).toBe("human");
    expect(state.deterministicRepairPasses).toBe(0);
    expect(state.reviewRepairPasses).toBe(0);
    expect(state.repairPasses).toBe(0);
    expect(assignmentsOf("review-repair")).toBe(0);
    expect(assignmentsOf("deterministic-repair")).toBe(0);
    expect(workerCalls).toBe(2);
    expect(state.reviewRouting?.outcome).toBe("human-fallback");
  });

  it("a clean review and Jev accept cannot override failed deterministic verification after the default budget is exhausted", async () => {
    config.verificationCommands = ['node -e "process.exit(require(\'fs\').readFileSync(\'a.txt\',\'utf8\').startsWith(\'baseline\')?0:1)"'];
    const state = await run();
    expect(state.baselineVerification?.passed).toBe(true);
    expect(state.verification?.passed).toBe(false);
    expect(state.finalStatus).toBe("human");
    expect(state.deterministicRepairPasses).toBe(DEFAULT_CONFIG.maxDeterministicRepairPasses);
    expect(state.reviewRepairPasses).toBe(0);
    expect(state.repairPasses).toBe(DEFAULT_CONFIG.maxDeterministicRepairPasses);
    expect(state.reviewRouting?.outcome).toBe("human-fallback");
    expect(state.sourceDisposition?.disposition).toBe("retained-unaccepted");
  });

  it("a clean review and confident accept still cannot accept failed verification after an explicit deterministic budget is exhausted", async () => {
    config.verificationCommands = ['node -e "process.exit(require(\'fs\').readFileSync(\'a.txt\',\'utf8\').startsWith(\'baseline\')?0:1)"'];
    config.maxDeterministicRepairPasses = 2;
    const state = await run();
    expect(state.baselineVerification?.passed).toBe(true);
    // Both repair attempts failed to restore the check; the budget is exhausted.
    expect(state.deterministicRepairPasses).toBe(2);
    expect(assignmentsOf("deterministic-repair")).toBe(2);
    expect(assignmentsOf("review-repair")).toBe(0);
    expect(state.reviewRepairPasses).toBe(0);
    expect(state.repairPasses).toBe(2);
    expect(json(runDir(state), "verification-after-deterministic-repair-1.json").passed).toBe(false);
    expect(json(runDir(state), "verification-after-deterministic-repair-2.json").passed).toBe(false);
    expect(state.verification?.passed).toBe(false);
    // Clean review and a confident, clean accept gate are preserved verbatim.
    expect(json(runDir(state), "review.json")).toEqual(review);
    expect(json(runDir(state), "review-gate.json")).toEqual(gate);
    // ...and final routing still refuses acceptance because verification failed.
    expect(state.finalStatus).toBe("human");
    expect(state.reviewRouting?.outcome).toBe("human-fallback");
    expect(state.reviewRouting?.verificationPassed).toBe(false);
    expect(state.sourceDisposition?.disposition).toBe("retained-unaccepted");
  });

  it("keeps a review-repair-introduced failure out of the deterministic repair route (review-before-deterministic-repair ordering is structurally impossible)", async () => {
    // Rationale for the ordering: the deterministic repair loop sits between
    // implementation and the initial review, and it is evaluated exactly once
    // — its termination condition (!verification.passed &&
    // deterministicRepairPasses < maxDeterministicRepairPasses) is never
    // re-evaluated after a review repair. Review repair re-verifies and
    // re-gates, but its outcome only feeds the final review routing, which
    // merely consumes verificationPassed; it cannot re-open the deterministic
    // loop. A check failure introduced during review repair therefore has no
    // deterministic-repair route by construction, not by configuration.
    const check = 'node -e "process.exit(require(\'fs\').readFileSync(\'a.txt\',\'utf8\').startsWith(\'good\')?0:1)"';
    config.verificationCommands = [check];
    writeFileSync(join(cwd, "a.txt"), "good baseline\n");
    await git(cwd, "add", "a.txt");
    await git(cwd, "commit", "-m", "good baseline");
    writeWorker = async (options) => {
      const kind = assignmentKind(options);
      if (kind === "implementation") {
        const id = workerId(options.prompt);
        // Implementation keeps the deterministic check passing.
        writeFileSync(join(options.cwd, `${id}.txt`), id === "a" ? "good implementation\n" : `implemented b\n`);
      } else if (kind === "deterministic-repair") {
        throw new Error("deterministic repair must not be reachable after review repair");
      } else {
        // The single review repair introduces the check failure.
        writeFileSync(join(options.cwd, "a.txt"), "broken after review repair\n");
      }
    };
    const requested: ReviewResult = { summary: "changes requested", verdict: "changes_requested", findings: [{ severity: "minor", title: "Inconsistent naming", explanation: "b.txt content is inconsistent with the objective.", file: "b.txt" }], testGaps: [], requirementCoverage: [] };
    reviewSequence = [requested, review];
    vi.mocked(JevDecisionEngine.prototype.gateReview)
      .mockResolvedValueOnce({ ...gate, action: "rework" })
      .mockResolvedValueOnce(gate); // clean accept after the repair

    const state = await run();

    // Passing initial verification, then failing re-verification after the repair.
    expect(json(runDir(state), "verification.json").passed).toBe(true);
    expect(json(runDir(state), "verification-after-review-repair-1.json").passed).toBe(false);
    expect(state.verification?.passed).toBe(false);
    // No deterministic repair worker is manufactured: counter, assignments,
    // and artifacts all stay at zero.
    expect(state.deterministicRepairPasses).toBe(0);
    expect(assignmentsOf("deterministic-repair")).toBe(0);
    expect(state.reviewRepairPasses).toBe(1);
    expect(state.repairPasses).toBe(1);
    expect(workerCalls).toBe(3);
    expect(readdirSync(runDir(state)).filter((file) => file.startsWith("deterministic-repair"))).toEqual([]);
    // A clean review and a confident, clean accept gate still cannot accept,
    // because final routing only consumes verificationPassed.
    expect(json(runDir(state), "review-after-repair-1.json")).toEqual(review);
    expect(json(runDir(state), "review-gate-after-repair-1.json")).toEqual(gate);
    expect(state.finalStatus).toBe("human");
    expect(state.reviewRouting?.outcome).toBe("human-fallback");
    expect(state.reviewRouting?.verificationPassed).toBe(false);
  });

  it("keeps repairPasses equal to the dedicated counters in returned state, persisted state, run summary, and every intermediate state write", async () => {
    const check = 'node -e "process.exit(require(\'fs\').readFileSync(\'a.txt\',\'utf8\').startsWith(\'good\')?0:1)"';
    config.verificationCommands = [check];
    writeFileSync(join(cwd, "a.txt"), "good baseline\n");
    await git(cwd, "add", "a.txt");
    await git(cwd, "commit", "-m", "good baseline");
    writeWorker = async (options) => {
      const kind = assignmentKind(options);
      if (kind === "implementation") {
        const id = workerId(options.prompt);
        writeFileSync(join(options.cwd, `${id}.txt`), id === "a" ? "bad implementation\n" : `implemented b\n`);
      } else if (kind === "deterministic-repair") {
        writeFileSync(join(options.cwd, "a.txt"), "good after deterministic repair\n");
      } else {
        writeFileSync(join(options.cwd, "b.txt"), "review repaired\n");
      }
    };
    const requested: ReviewResult = { summary: "changes requested", verdict: "changes_requested", findings: [{ severity: "minor", title: "Inconsistent naming", explanation: "b.txt content is inconsistent with the objective.", file: "b.txt" }], testGaps: [], requirementCoverage: [] };
    reviewSequence = [requested, requested, review];
    vi.mocked(JevDecisionEngine.prototype.gateReview)
      .mockResolvedValueOnce({ ...gate, action: "rework" })
      .mockResolvedValueOnce({ ...gate, action: "rework" })
      .mockResolvedValueOnce(gate);

    // One deterministic repair followed by two review repairs. The progress
    // callback observes state.json synchronously after each repair stage
    // completes; the controller persists telemetry/state before emitting the
    // "completed" progress event.
    const intermediate: Array<{ deterministicRepairPasses: number; reviewRepairPasses: number; repairPasses: number }> = [];
    const progress = (event: { type: string; telemetry?: { stage: string } }) => {
      if (event.type !== "completed" || event.telemetry?.stage !== "repairer") return;
      const [runId] = readdirSync(join(cwd, config.runRoot));
      const persisted = json(join(cwd, config.runRoot, runId), "state.json");
      intermediate.push({
        deterministicRepairPasses: persisted.deterministicRepairPasses,
        reviewRepairPasses: persisted.reviewRepairPasses,
        repairPasses: persisted.repairPasses,
      });
    };

    const state = await runFactory(cwd, "fixture reliability change", config, progress);

    // The aggregate never diverges from the dedicated counters, including in
    // the persisted intermediate states written after each repair pass.
    expect(intermediate).toEqual([
      { deterministicRepairPasses: 1, reviewRepairPasses: 0, repairPasses: 1 },
      { deterministicRepairPasses: 1, reviewRepairPasses: 1, repairPasses: 2 },
      { deterministicRepairPasses: 1, reviewRepairPasses: 2, repairPasses: 3 },
    ]);
    expect(state.deterministicRepairPasses).toBe(1);
    expect(state.reviewRepairPasses).toBe(2);
    expect(state.repairPasses).toBe(state.deterministicRepairPasses + state.reviewRepairPasses);
    expect(state.repairPasses).toBe(3);
    expect(state.finalStatus).toBe("accepted");
    expect(json(runDir(state), "state.json")).toMatchObject({ deterministicRepairPasses: 1, reviewRepairPasses: 2, repairPasses: 3 });
    expect(json(runDir(state), "run-summary.json")).toMatchObject({ deterministicRepairPasses: 1, reviewRepairPasses: 2, repairPasses: 3 });
  });

  it("counts the deterministic repair pass when its worker gate stops the repair early (blocked)", async () => {
    config.verificationCommands = ['node -e "process.exit(require(\'fs\').readFileSync(\'a.txt\',\'utf8\').startsWith(\'baseline\')?0:1)"'];
    vi.mocked(JevDecisionEngine.prototype.gateWorker)
      .mockResolvedValueOnce({ disposition: "ready", confidence: 1, raw: {} })
      .mockResolvedValueOnce({ disposition: "ready", confidence: 1, raw: {} })
      .mockResolvedValueOnce({ disposition: "blocked", confidence: 1, raw: {} });
    const state = await run();
    expect(state.finalStatus).toBe("human");
    expect(state.finalReason).toContain("deterministic repair 1");
    expect(state.deterministicRepairPasses).toBe(1);
    expect(state.reviewRepairPasses).toBe(0);
    expect(state.repairPasses).toBe(1);
    expect(assignmentsOf("deterministic-repair")).toBe(1);
    expect(workerCalls).toBe(3);
    // The assignment's worker report and blocking gate are persisted, but the
    // early stop means no re-verification artifact exists.
    expect(json(runDir(state), "deterministic-repair-1.json")).toMatchObject({ summary: expect.any(String) });
    expect(json(runDir(state), "deterministic-repair-gate-1.json")).toMatchObject({ disposition: "blocked" });
    expect(readdirSync(runDir(state))).not.toContain("verification-after-deterministic-repair-1.json");
    expect(json(runDir(state), "state.json")).toMatchObject({ deterministicRepairPasses: 1, reviewRepairPasses: 0, repairPasses: 1, finalStatus: "human" });
    expect(json(runDir(state), "run-summary.json")).toMatchObject({ deterministicRepairPasses: 1, reviewRepairPasses: 0, repairPasses: 1 });
  });

  it("counts the deterministic repair pass when its worker throws after the pass has started", async () => {
    config.verificationCommands = ['node -e "process.exit(require(\'fs\').readFileSync(\'a.txt\',\'utf8\').startsWith(\'baseline\')?0:1)"'];
    writeWorker = async (options) => {
      if (assignmentKind(options) === "deterministic-repair") throw new Error("injected deterministic repair failure");
      const id = workerId(options.prompt);
      writeFileSync(join(options.cwd, `${id}.txt`), `implemented ${id}\n`);
    };
    const state = await run();
    expect(state.finalStatus).toBe("failed");
    expect(state.finalReason).toContain("injected deterministic repair failure");
    // The pass was already counted at assignment start even though the worker
    // threw before submitting a report.
    expect(state.deterministicRepairPasses).toBe(1);
    expect(state.reviewRepairPasses).toBe(0);
    expect(state.repairPasses).toBe(1);
    expect(workerCalls).toBe(3);
    const files = readdirSync(runDir(state));
    expect(files).not.toContain("deterministic-repair-1.json");
    expect(files).not.toContain("deterministic-repair-gate-1.json");
    expect(files).not.toContain("verification-after-deterministic-repair-1.json");
    expect(json(runDir(state), "state.json")).toMatchObject({ deterministicRepairPasses: 1, reviewRepairPasses: 0, repairPasses: 1, finalStatus: "failed" });
    expect(json(runDir(state), "run-summary.json")).toMatchObject({ deterministicRepairPasses: 1, reviewRepairPasses: 0, repairPasses: 1, finalStatus: "failed" });
  });

  it("persists checkpoint evidence for a review repair without consuming an additional review pass", async () => {
    config.models = structuredClone(roleModels);
    let reviewRepairCheckpoint = 0;
    vi.mocked(agents.runCheckpointableAgent).mockImplementation(async (options) => {
      runnerCalls.push({ fn: "runCheckpointableAgent", role: options.role, model: options.model });
      workerCalls++;
      const kind = assignmentKind(options);
      await writeWorker(options);
      // Repair prompts carry the pass-scoped unitId directly; implementation
      // prompts use the currentUnit id.
      const id = kind === "implementation" ? workerId(options.prompt) : /"unitId": "([^"]+)"/.exec(options.prompt)?.[1] ?? "a";
      workerAssignments.push({ kind, unitId: id });
      if (kind === "review-repair" && reviewRepairCheckpoint === 0) {
        reviewRepairCheckpoint++;
        // First segment of the single review repair ends in a checkpoint.
        return { kind: "checkpoint", checkpoint: makeCheckpointFixture({ unitId: id }), context: { tokens: 70_000, contextWindow: 100_000, percent: 70 }, metrics: runnerMetrics(options.model) };
      }
      return { kind: "result", result: options.validate(makeWorkerReportFixture({ unitId: id, changedFiles: [`${id}.txt`] })), metrics: runnerMetrics(options.model) };
    });
    vi.mocked(JevDecisionEngine.prototype.gateReview).mockResolvedValueOnce({ ...gate, action: "rework" });
    const state = await run();
    expect(state.finalStatus).toBe("accepted");
    expect(state.deterministicRepairPasses).toBe(0);
    expect(state.reviewRepairPasses).toBe(1);
    expect(state.repairPasses).toBe(1);
    // Two worker segments served exactly one review repair pass: the
    // checkpoint and its resumed segment consume no additional pass.
    expect(reviewRepairCheckpoint).toBe(1);
    expect(workerCalls).toBe(4);
    const files = readdirSync(runDir(state));
    expect(files).toContain("checkpoint-review-repair-1-1.json");
    expect(files).toContain("review-repair-1.json");
    expect(files).toContain("review-repair-gate-1.json");
    const checkpoint = json(runDir(state), "checkpoint-review-repair-1-1.json");
    expect(checkpoint).toMatchObject({ stage: "repairer", label: "review repair 1", index: 1 });
    expect(checkpoint.checkpoint).toMatchObject({ unitId: "review-repair-1" });
    expect(checkpoint.context).toMatchObject({ tokens: 70_000 });
    expect(state.checkpoints).toHaveLength(1);
    expect(state.checkpoints?.[0]).toMatchObject({ stage: "repairer", label: "review repair 1", index: 1 });
    // Both repair segments (original and checkpoint-resumed) resolved the
    // repairer role's ModelRef, and telemetry reports the resolved model.
    const repairerCalls = runnerCalls.filter((call) => call.fn === "runCheckpointableAgent" && call.role === "repairer");
    expect(repairerCalls).toEqual([
      { fn: "runCheckpointableAgent", role: "repairer", model: roleModels.repairer },
      { fn: "runCheckpointableAgent", role: "repairer", model: roleModels.repairer },
    ]);
    expect(state.telemetry?.filter((stage) => stage.stage === "repairer").map((stage) => [stage.stage, stage.actor, stage.model, stage.outcome])).toEqual([
      ["repairer", "agent", "prov-repairer/model-repairer", "completed"],
      ["repairer", "agent", "prov-repairer/model-repairer", "completed"],
    ]);
    expect(json(runDir(state), "state.json")).toMatchObject({ deterministicRepairPasses: 0, reviewRepairPasses: 1, repairPasses: 1 });
    expect(json(runDir(state), "run-summary.json")).toMatchObject({ deterministicRepairPasses: 0, reviewRepairPasses: 1, repairPasses: 1 });
  });

  it("runs a deterministic repair continuation under the default continuation budget without consuming an additional repair pass", async () => {
    config.models = structuredClone(roleModels);
    const check = 'node -e "process.exit(require(\'fs\').readFileSync(\'a.txt\',\'utf8\').startsWith(\'good\')?0:1)"';
    config.verificationCommands = [check];
    writeFileSync(join(cwd, "a.txt"), "good baseline\n");
    await git(cwd, "add", "a.txt");
    await git(cwd, "commit", "-m", "good baseline");
    let deterministicSegments = 0;
    writeWorker = async (options) => {
      const kind = assignmentKind(options);
      if (kind === "implementation") {
        const id = workerId(options.prompt);
        writeFileSync(join(options.cwd, `${id}.txt`), id === "a" ? "bad implementation\n" : `implemented b\n`);
      } else if (kind === "deterministic-repair") {
        deterministicSegments++;
        // The initial repair leaves the check failing; the continuation fixes it.
        writeFileSync(join(options.cwd, "a.txt"), deterministicSegments === 1 ? "still failing after repair\n" : "good after continuation\n");
      }
    };
    vi.mocked(JevDecisionEngine.prototype.gateWorker)
      .mockResolvedValueOnce({ disposition: "ready", confidence: 1, raw: {} })
      .mockResolvedValueOnce({ disposition: "ready", confidence: 1, raw: {} })
      .mockResolvedValueOnce({ disposition: "continue", confidence: 1, raw: {} })
      .mockResolvedValueOnce({ disposition: "ready", confidence: 1, raw: {} });
    const state = await run();
    expect(state.finalStatus).toBe("accepted");
    // The continuation belongs to the same repair pass: one pass, two segments.
    expect(state.deterministicRepairPasses).toBe(1);
    expect(state.reviewRepairPasses).toBe(0);
    expect(state.repairPasses).toBe(1);
    expect(deterministicSegments).toBe(2);
    expect(workerCalls).toBe(4);
    // The continuation budget is untouched: one continuation within the default.
    expect(config.maxWorkerContinuationPasses).toBe(DEFAULT_CONFIG.maxWorkerContinuationPasses);
    expect(state.workerContinuations).toHaveLength(1);
    expect(state.workerContinuations?.[0]).toMatchObject({
      phase: "repair", label: "deterministic repair 1", pass: 1, priorDisposition: "continue",
      repairClass: "deterministic", repairPass: 1,
    });
    const continuation = json(runDir(state), "continuation-deterministic-repair-1-1.json");
    expect(continuation).toMatchObject({
      phase: "repair", pass: 1, priorDisposition: "continue",
      repairClass: "deterministic", repairPass: 1,
    });
    const files = readdirSync(runDir(state));
    for (const file of [
      "deterministic-repair-1.json",
      "deterministic-repair-1-continue-1.json",
      "deterministic-repair-gate-1.json",
      "deterministic-repair-gate-1-continue-1.json",
      "continuation-deterministic-repair-1-1.json",
      "verification-after-deterministic-repair-1.json",
    ]) expect(files).toContain(file);
    expect(json(runDir(state), "deterministic-repair-gate-1.json")).toMatchObject({ disposition: "continue" });
    expect(json(runDir(state), "deterministic-repair-gate-1-continue-1.json")).toMatchObject({ disposition: "ready" });
    expect(json(runDir(state), "verification-after-deterministic-repair-1.json").passed).toBe(true);
    // Decision history identifies the class and pass for the continuation and
    // for both gates of the same pass.
    const continuations = decisionsOf(state, "worker-continuation");
    expect(continuations).toHaveLength(1);
    expect(continuations[0]).toMatchObject({ stage: "worker-continuation", phase: "repair", pass: 1, repairClass: "deterministic", repairPass: 1 });
    expect(decisionsOf(state, "worker-gate")
      .filter((d) => d.repairClass === "deterministic")
      .map((d) => [d.repairPass, d.decision.disposition])).toEqual([[1, "continue"], [1, "ready"]]);
    // Both deterministic repair segments (original and Jev-continuation)
    // resolved the repairer role's ModelRef.
    const repairerCalls = runnerCalls.filter((call) => call.fn === "runCheckpointableAgent" && call.role === "repairer");
    expect(repairerCalls).toEqual([
      { fn: "runCheckpointableAgent", role: "repairer", model: roleModels.repairer },
      { fn: "runCheckpointableAgent", role: "repairer", model: roleModels.repairer },
    ]);
    expect(state.telemetry?.filter((stage) => stage.stage === "repairer").map((stage) => [stage.stage, stage.actor, stage.model, stage.outcome])).toEqual([
      ["repairer", "agent", "prov-repairer/model-repairer", "completed"],
      ["repairer", "agent", "prov-repairer/model-repairer", "completed"],
    ]);
  });

  it("runs zero repair assignments when both explicit budgets are zero, and reaches HUMAN through final-review routing", async () => {
    config.maxDeterministicRepairPasses = 0;
    config.maxReviewRepairPasses = 0;
    config.verificationCommands = ['node -e "process.exit(require(\'fs\').readFileSync(\'a.txt\',\'utf8\').startsWith(\'baseline\')?0:1)"'];
    gate.action = "rework"; // confident rework cannot override the zero budgets
    const state = await run();
    expect(state.finalStatus).toBe("human");
    expect(state.deterministicRepairPasses).toBe(0);
    expect(state.reviewRepairPasses).toBe(0);
    expect(state.repairPasses).toBe(0);
    expect(assignmentsOf("deterministic-repair")).toBe(0);
    expect(assignmentsOf("review-repair")).toBe(0);
    expect(workerCalls).toBe(2);
    const files = readdirSync(runDir(state));
    expect(files).not.toContain("deterministic-repair-1.json");
    expect(files).not.toContain("review-repair-1.json");
    expect(files).not.toContain("verification-after-deterministic-repair-1.json");
    expect(files).not.toContain("verification-after-review-repair-1.json");
    expect(state.telemetry?.some((stage) => stage.stage === "repairer")).toBe(false);
    expect(state.reviewRouting?.outcome).toBe("human-fallback");
    expect(json(runDir(state), "state.json")).toMatchObject({ deterministicRepairPasses: 0, reviewRepairPasses: 0, repairPasses: 0 });
    expect(json(runDir(state), "run-summary.json")).toMatchObject({ deterministicRepairPasses: 0, reviewRepairPasses: 0, repairPasses: 0 });
  });

  it("honors an explicit deterministic budget greater than one, counting repair assignments separately from implementation workers", async () => {
    config.maxDeterministicRepairPasses = 2;
    const check = 'node -e "process.exit(require(\'fs\').readFileSync(\'a.txt\',\'utf8\').startsWith(\'good\')?0:1)"';
    config.verificationCommands = [check];
    writeFileSync(join(cwd, "a.txt"), "good baseline\n");
    await git(cwd, "add", "a.txt");
    await git(cwd, "commit", "-m", "good baseline");
    let deterministicSegments = 0;
    writeWorker = async (options) => {
      const kind = assignmentKind(options);
      if (kind === "implementation") {
        const id = workerId(options.prompt);
        writeFileSync(join(options.cwd, `${id}.txt`), id === "a" ? "bad implementation\n" : `implemented b\n`);
      } else if (kind === "deterministic-repair") {
        deterministicSegments++;
        // Repair 1 leaves the check failing; repair 2 restores it.
        writeFileSync(join(options.cwd, "a.txt"), deterministicSegments === 1 ? "still failing after repair\n" : "good after second deterministic repair\n");
      }
    };
    const state = await run();
    expect(state.finalStatus).toBe("accepted");
    expect(state.deterministicRepairPasses).toBe(2);
    expect(state.reviewRepairPasses).toBe(0);
    expect(state.repairPasses).toBe(2);
    // Repair assignments are counted separately from implementation workers.
    expect(assignmentsOf("deterministic-repair")).toBe(2);
    expect(assignmentsOf("implementation")).toBe(2);
    expect(workerCalls).toBe(4);
    expect(json(runDir(state), "verification-after-deterministic-repair-1.json").passed).toBe(false);
    expect(json(runDir(state), "verification-after-deterministic-repair-2.json").passed).toBe(true);
    // Only implementation workers contribute to state.workers; repair reports
    // are pass-scoped artifacts, not implementation evidence.
    expect(state.workers?.map((report) => report.unitId)).toEqual(["a", "b"]);
    expect(state.telemetry?.filter((stage) => stage.stage === "implementer")).toHaveLength(2);
    expect(state.telemetry?.filter((stage) => stage.stage === "repairer")).toHaveLength(2);
    const files = readdirSync(runDir(state));
    expect(files).not.toContain("review-repair-1.json");
    expect(files).toContain("deterministic-repair-1.json");
    expect(files).toContain("deterministic-repair-2.json");
    expect(json(runDir(state), "run-summary.json")).toMatchObject({ deterministicRepairPasses: 2, reviewRepairPasses: 0, repairPasses: 2 });
  });

  it("uses non-default final thresholds in the actual controller", async () => {
    config.jev.minChoiceConfidence = 0.99;
    config.jev.minNoulProbability = 0.95;
    gate.confidence = 0.98;
    const state = await run();
    expect(state.finalStatus).toBe("human");
    expect(state.reviewRouting).toMatchObject({ outcome: "human-fallback", minChoiceConfidence: 0.99, minNoulProbability: 0.95 });
  });

  it("retains pre-existing staged, unstaged and binary source evidence without resetting the user index", async () => {
    config.requireCleanWorkingTree = false;
    writeFileSync(join(cwd, "user.txt"), "staged user content\n");
    await git(cwd, "add", "user.txt");
    writeFileSync(join(cwd, "user.txt"), "unstaged user content\n");
    writeFileSync(join(cwd, "user.bin"), Buffer.from([0, 1, 2, 255]));
    const staged = await git(cwd, "diff", "--cached", "--binary");
    gate.action = "human";
    const state = await run();
    const before = json(runDir(state), "source-before.json");
    const after = json(runDir(state), "source-after.json");
    expect(before.stagedDiff).toContain("staged user content");
    expect(before.diff).toContain("unstaged user content");
    expect(before.diff).toContain("GIT binary patch");
    expect(after.diff).not.toContain(".pi/software-factory/runs");
    expect(await git(cwd, "diff", "--cached", "--binary")).toBe(staged);
    expect(readFileSync(join(cwd, "user.bin"))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(await git(cwd, "rev-parse", "HEAD")).toBe(originalHead);
  });

  it("fails closed if terminal source capture fails", async () => {
    const capture = gitEvidence.captureGitEvidence;
    vi.mocked(JevDecisionEngine.prototype.gateReview).mockImplementation(async () => {
      vi.spyOn(gitEvidence, "captureGitEvidence").mockRejectedValueOnce(new Error("terminal capture unavailable"));
      return gate;
    });
    const state = await run();
    expect(state.finalStatus).toBe("human");
    expect(state.sourceDisposition?.disposition).toBe("unknown-retained");
    expect(state.finalReason).toContain("terminal capture unavailable");
    expect(existsSync(lockPath())).toBe(true);
    vi.mocked(gitEvidence.captureGitEvidence).mockImplementation(capture);
  });

  it("does not accept cancellation arriving during terminal evidence capture", async () => {
    const abort = new AbortController();
    const capture = gitEvidence.captureGitEvidence;
    vi.mocked(JevDecisionEngine.prototype.gateReview).mockImplementation(async () => {
      vi.spyOn(gitEvidence, "captureGitEvidence").mockImplementationOnce(async (...args) => {
        const evidence = await capture(...args);
        abort.abort();
        return evidence;
      });
      return gate;
    });
    const state = await run(abort.signal);
    expect(state.finalStatus).toBe("human");
    expect(state.sourceDisposition?.disposition).toBe("unknown-retained");
    expect(state.finalReason).toContain("cancelled");
    expect(existsSync(lockPath())).toBe(true);
  });

  it("refuses acceptance when source changes during review after verification", async () => {
    vi.mocked(JevDecisionEngine.prototype.gateReview).mockImplementation(async () => {
      writeFileSync(join(cwd, "a.txt"), "unverified concurrent change\n");
      return gate;
    });
    const state = await run();
    expect(state.reviewRouting?.outcome).toBe("bounded-low-sufficiency-acceptance");
    expect(state.finalStatus).toBe("human");
    expect(state.finalReason).toContain("Source changed after authoritative verification");
    expect(state.sourceDisposition?.disposition).toBe("unknown-retained");
  });

  it("keeps failed/cancelled parallel worktrees; primary source is never partly integrated", async () => {
    config.parallelImplementation.enabled = true;
    restoreDefaultUnitScopes();
    let peerStarted!: () => void;
    const started = new Promise<void>((resolve) => { peerStarted = resolve; });
    writeWorker = async (options) => {
      const id = workerId(options.prompt);
      writeFileSync(join(options.cwd, `${id}.txt`), `parallel ${id}\n`);
      if (id === "b") {
        peerStarted();
        throw new Error("parallel failure");
      }
      await started;
      // Cooperate with the controller's sibling abort rather than leave a writer active.
      if (!options.abortSignal?.aborted) await new Promise<void>((resolve) => options.abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("peer cancelled");
    };
    const state = await run();
    expect(state.finalStatus).toBe("human");
    expect(state.sourceDisposition?.disposition).toBe("unknown-retained");
    expect(await git(cwd, "diff")).toBe("");
    const disposition = json(runDir(state), "source-disposition.json");
    expect(disposition.retainedWorktrees).toHaveLength(2);
    const retained = disposition.retainedWorktrees.flatMap((dir: string) => ["a", "b"].map((id) => readFileSync(join(dir, `${id}.txt`), "utf8")));
    expect(retained).toContain("parallel a\n");
    expect(retained).toContain("parallel b\n");
    expect(existsSync(lockPath())).toBe(true);
  });

  it("preserves integrated parallel-batch evidence if final review requires HUMAN", async () => {
    config.parallelImplementation.enabled = true;
    restoreDefaultUnitScopes();
    gate.action = "human";
    const state = await run();
    expect(state.finalStatus).toBe("human");
    expect(state.sourceDisposition?.disposition).toBe("retained-unaccepted");
    const patches = readdirSync(runDir(state)).filter((file) => file.startsWith("parallel-change-"));
    expect(patches).toHaveLength(2);
    for (const file of patches) expect(json(runDir(state), file).patch).toContain("implemented");
    expect((await git(cwd, "worktree", "list", "--porcelain")).match(/^worktree /gm)).toHaveLength(1);
  });

  it("enforces actual scope using raw Unicode/spaced Git paths rather than quoted display names", async () => {
    const id = "données 雪";
    architecture.implementationUnits = [{ id, objective: id, filesExpected: [`${id}.txt`], acceptance: [], constraints: [], dependsOn: [] }];
    const state = await run();
    expect(state.finalStatus, state.finalReason).toBe("accepted");
    const scopeFile = readdirSync(runDir(state)).find((file) => file.startsWith("implementation-scope-"))!;
    expect(json(runDir(state), scopeFile).actualChangedPaths).toEqual([`${id}.txt`]);
  });

  it("crosses sequential scope snapshots when the runtime prefix is Git-ignored, even with a failing clean filter", async () => {
    // Reproduce the real host setup: the run root is ignored locally, while
    // runtime content is also covered by a required clean filter that must
    // never be invoked by scope snapshot capture.
    writeFileSync(join(cwd, ".git", "info", "exclude"), ".pi/software-factory/runs/\n");
    writeFileSync(join(cwd, ".git", "info", "attributes"), ".pi/software-factory/runs/** filter=fail\n");
    await git(cwd, "config", "filter.fail.clean", 'node -e "process.exit(1)"');
    await git(cwd, "config", "filter.fail.required", "true");
    restoreDefaultUnitScopes();

    const state = await run();

    expect(workerCalls).toBeGreaterThan(0);
    expect(state.finalStatus, state.finalReason).toBe("accepted");
    expect(json(runDir(state), "source-after.json").diff).not.toContain(".pi/software-factory/runs");
  });

  it("retains the whole run when a sequential unit fails after parallel integration", async () => {
    config.parallelImplementation.enabled = true;
    restoreDefaultUnitScopes();
    architecture.implementationUnits.push({ id: "c", objective: "c", filesExpected: ["c.txt"], acceptance: [], constraints: [], dependsOn: ["a", "b"] });
    writeWorker = async (options) => {
      const id = workerId(options.prompt);
      writeFileSync(join(options.cwd, `${id}.txt`), `partial ${id}\n`);
      if (id === "c") throw new Error("later sequential failure");
    };
    const state = await run();
    expect(state.finalStatus).toBe("failed");
    expect(json(runDir(state), "parallel-batch-1.json").outcome).toBe("integrated");
    const after = json(runDir(state), "source-after.json");
    for (const id of ["a", "b", "c"]) expect(after.diff).toContain(`partial ${id}`);
    expect(state.sourceDisposition?.disposition).toBe("unknown-retained");
    expect(existsSync(lockPath())).toBe(true);
    expect(await git(cwd, "rev-parse", "HEAD")).toBe(originalHead);
  });

  it("does not overwrite run evidence for starts in the same second", () => {
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2026-09-26T00:00:00.000Z");
    const root = join(cwd, config.runRoot);
    const first = createRunStore(root);
    const second = createRunStore(root);
    first.write("state.json", { objective: "first" });
    second.write("state.json", { objective: "second" });
    expect(first.dir).not.toBe(second.dir);
    expect(json(first.dir, "state.json")).toEqual({ objective: "first" });
    expect(json(second.dir, "state.json")).toEqual({ objective: "second" });
    expect(readdirSync(first.dir)).toEqual(["state.json"]);
  });

  it("blocks an interrupted or concurrent transaction without replacing its journal", async () => {
    const store = createRunStore(join(cwd, config.runRoot));
    const transaction = await reserveRun(cwd, store);
    await transaction.begin([config.runRoot]);
    const journal = readFileSync(lockPath(), "utf8");
    const state = await run();
    expect(state.finalStatus).toBe("blocked");
    expect(state.finalReason).toContain(JSON.stringify(store.dir));
    expect(readFileSync(lockPath(), "utf8")).toBe(journal);
    expect(workerCalls).toBe(0);
    expect(ModelRuntime.create).not.toHaveBeenCalled();
  });

  it("journals check-command mutations even when the baseline blocks before models", async () => {
    config.verificationCommands = ['node -e "require(\'fs\').writeFileSync(\'baseline-output.txt\',\'partial\');process.exit(1)"'];
    const state = await run();
    expect(state.finalStatus).toBe("blocked");
    expect(state.sourceDisposition?.disposition).toBe("retained-unaccepted");
    expect(json(runDir(state), "source-after.json").diff).toContain("baseline-output.txt");
    expect(workerCalls).toBe(0);
  });

  it("excludes tracked/unstaged and spaced runtime paths without losing status columns", async () => {
    const runtime = "runtime [1]";
    mkdirSync(join(cwd, runtime));
    writeFileSync(join(cwd, runtime, "artifact.txt"), "before\n");
    await git(cwd, "add", ".");
    await git(cwd, "commit", "-m", "tracked runtime");
    writeFileSync(join(cwd, runtime, "artifact.txt"), "after\n");
    expect(await gitStatus(cwd, [runtime])).toBe("");
    writeFileSync(join(cwd, "a.txt"), "user edit\n");
    expect(await gitStatus(cwd, [runtime])).toBe(" M a.txt");
  });

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

  it("routes parallel implementer workers to models.implementer", async () => {
    config.models = structuredClone(roleModels);
    config.parallelImplementation.enabled = true;
    restoreDefaultUnitScopes();
    const state = await run();
    expect(state.finalStatus).toBe("accepted");
    expect(json(runDir(state), "parallel-batch-1.json").outcome).toBe("integrated");
    expect(runnerCalls.filter((call) => call.fn === "runCheckpointableAgent")).toEqual([
      { fn: "runCheckpointableAgent", role: "implementer", model: roleModels.implementer },
      { fn: "runCheckpointableAgent", role: "implementer", model: roleModels.implementer },
    ]);
    expect(state.telemetry?.filter((stage) => stage.stage === "implementer").map((stage) => [stage.stage, stage.actor, stage.model, stage.outcome])).toEqual([
      ["implementer", "agent", "prov-implementer/model-implementer", "completed"],
      ["implementer", "agent", "prov-implementer/model-implementer", "completed"],
    ]);
  });

}, 30_000);

describe("semantic stage identifiers", () => {
  it("retains failed repairer work as unknown-retained with the lock in place", async () => {
    config.models = structuredClone(roleModels);
    config.verificationCommands = ['node -e "process.exit(require(\'fs\').readFileSync(\'a.txt\',\'utf8\').startsWith(\'good\')?0:1)"'];
    // Baseline passes: a.txt already carries the "good" prefix.
    writeFileSync(join(cwd, "a.txt"), "good baseline\n");
    await git(cwd, "add", "a.txt");
    await git(cwd, "commit", "-m", "good baseline");
    writeWorker = async (options) => {
      if (assignmentKind(options) === "deterministic-repair") throw new Error("injected repairer failure");
      const id = workerId(options.prompt);
      writeFileSync(join(options.cwd, `${id}.txt`), `implemented ${id}\n`);
    };
    const state = await run();
    expect(state.finalStatus).toBe("failed");
    expect(state.finalReason).toContain("injected repairer failure");
    expect(state.telemetry?.some((stage) => stage.stage === "repairer" && stage.outcome === "failed")).toBe(true);
    expect(state.sourceDisposition?.disposition).toBe("unknown-retained");
    expect(existsSync(lockPath())).toBe(true);
  });

}, 30_000);
