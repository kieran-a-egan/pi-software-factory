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
import { reserveRun } from "../src/run-safety.js";
import { createRunStore } from "../src/storage.js";
import { gitStatus } from "../src/verification.js";
import type { ArchitectureResult, FactoryConfig, FactoryRunState, ReviewGateDecision, ReviewResult } from "../src/types.js";
import { makeCheckpointFixture, makeFakeModelRuntime, makeScoutResultFixture, makeWorkerReportFixture } from "./helpers/agent-runner-harness.js";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await exec("git", args, { cwd, windowsHide: true })).stdout;
}
const metrics: agents.AgentRunMetrics = {
  model: "fixture", cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
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
    implementationUnits: ["a", "b"].map((id) => ({ id, objective: id, filesExpected: [`${id}.txt`], acceptance: [], constraints: [], dependsOn: [] })),
  };
  review = { summary: "clean", verdict: "clean", findings: [], testGaps: [], requirementCoverage: [] };
  gate = { action: "accept", confidence: 1, residualRisk: "low", reviewSufficientProbability: 0.57, raw: { score: 0.57 } };
  workerCalls = 0;
  workerAssignments = [];
  reviewSequence = [review];
  reviewCalls = 0;
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
  vi.spyOn(agents, "runAgent").mockImplementation(async (options) => ({
    result: options.validate(
      options.role === "scout" ? makeScoutResultFixture()
        : options.role === "architect" ? architecture
        : reviewSequence[Math.min(reviewCalls++, reviewSequence.length - 1)],
    ), metrics,
  }));
  vi.spyOn(agents, "runCheckpointableAgent").mockImplementation(async (options) => {
    workerCalls++;
    await writeWorker(options);
    const id = workerId(options.prompt);
    workerAssignments.push({ kind: assignmentKind(options), unitId: id });
    return { kind: "result", result: options.validate(makeWorkerReportFixture({ unitId: id, changedFiles: [`${id}.txt`] })), metrics };
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

  it("a clean Astra review and Jev accept cannot override failed deterministic verification after the default budget is exhausted", async () => {
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

  it("a clean Astra review and confident accept still cannot accept failed verification after an explicit deterministic budget is exhausted", async () => {
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
      if (event.type !== "completed" || event.telemetry?.stage !== "qwen-repair") return;
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
    let reviewRepairCheckpoint = 0;
    vi.mocked(agents.runCheckpointableAgent).mockImplementation(async (options) => {
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
        return { kind: "checkpoint", checkpoint: makeCheckpointFixture({ unitId: id }), context: { tokens: 70_000, contextWindow: 100_000, percent: 70 }, metrics };
      }
      return { kind: "result", result: options.validate(makeWorkerReportFixture({ unitId: id, changedFiles: [`${id}.txt`] })), metrics };
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
    expect(checkpoint).toMatchObject({ stage: "qwen-repair", label: "review repair 1", index: 1 });
    expect(checkpoint.checkpoint).toMatchObject({ unitId: "review-repair-1" });
    expect(checkpoint.context).toMatchObject({ tokens: 70_000 });
    expect(state.checkpoints).toHaveLength(1);
    expect(state.checkpoints?.[0]).toMatchObject({ stage: "qwen-repair", label: "review repair 1", index: 1 });
    expect(json(runDir(state), "state.json")).toMatchObject({ deterministicRepairPasses: 0, reviewRepairPasses: 1, repairPasses: 1 });
    expect(json(runDir(state), "run-summary.json")).toMatchObject({ deterministicRepairPasses: 0, reviewRepairPasses: 1, repairPasses: 1 });
  });

  it("runs a deterministic repair continuation under the default continuation budget without consuming an additional repair pass", async () => {
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
    expect(state.telemetry?.some((stage) => stage.stage === "qwen-repair")).toBe(false);
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
    expect(state.telemetry?.filter((stage) => stage.stage === "qwen-implement")).toHaveLength(2);
    expect(state.telemetry?.filter((stage) => stage.stage === "qwen-repair")).toHaveLength(2);
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

  it("excludes runtime artifacts during sequential snapshots, even with a failing Git clean filter", async () => {
    writeFileSync(join(cwd, ".git", "info", "attributes"), ".pi/software-factory/runs/** filter=fail\n");
    await git(cwd, "config", "filter.fail.clean", 'node -e "process.exit(1)"');
    await git(cwd, "config", "filter.fail.required", "true");
    const state = await run();
    expect(state.finalStatus, state.finalReason).toBe("accepted");
    expect(json(runDir(state), "source-after.json").diff).not.toContain(".pi/software-factory/runs");
  });

  it("retains the whole run when a sequential unit fails after parallel integration", async () => {
    config.parallelImplementation.enabled = true;
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
}, 30_000);
