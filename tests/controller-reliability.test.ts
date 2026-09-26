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
import { makeFakeModelRuntime, makeScoutResultFixture, makeWorkerReportFixture } from "./helpers/agent-runner-harness.js";

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

const json = (dir: string, file: string) => JSON.parse(readFileSync(join(dir, file), "utf8"));
const runDir = (state: FactoryRunState) => join(cwd, config.runRoot, state.id);
const lockPath = () => join(cwd, ".git", "pi-software-factory.lock");
const run = (signal?: AbortSignal) => runFactory(cwd, "fixture reliability change", config, () => {}, signal);
const workerId = (prompt: string) => /"currentUnit":\s*\{\s*"id": "([^"]+)"/.exec(prompt)?.[1] ?? "a";

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
    result: options.validate(options.role === "scout" ? makeScoutResultFixture() : options.role === "architect" ? architecture : review), metrics,
  }));
  vi.spyOn(agents, "runCheckpointableAgent").mockImplementation(async (options) => {
    workerCalls++;
    await writeWorker(options);
    const id = workerId(options.prompt);
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
    expect(state.repairPasses).toBe(0);
    expect(state.reviewRouting?.outcome).toBe("human-fallback");
    expect(json(runDir(state), "review-routing.json").action).toBe(action);
    expect(state.sourceDisposition?.disposition).toBe("retained-unaccepted");
  });

  it("preserves bounded rework, re-verification and final routing without increasing repair budgets", async () => {
    vi.mocked(JevDecisionEngine.prototype.gateReview).mockResolvedValueOnce({ ...gate, action: "rework" });
    const state = await run();
    expect(state.finalStatus).toBe("accepted");
    expect(state.repairPasses).toBe(1);
    expect(workerCalls).toBe(3);
    expect(json(runDir(state), "verification-1.json").passed).toBe(true);
    expect(json(runDir(state), "review-gate-1.json")).toEqual(gate);
  });

  it("stops at the existing repair budget when final rework persists", async () => {
    gate.action = "rework";
    const state = await run();
    expect(state.finalStatus).toBe("human");
    expect(state.repairPasses).toBe(DEFAULT_CONFIG.maxRepairPasses);
    expect(workerCalls).toBe(3);
    expect(state.reviewRouting?.outcome).toBe("human-fallback");
  });

  it("low action confidence still prevents rework and requires HUMAN", async () => {
    gate.action = "rework";
    gate.confidence = 0.59;
    const state = await run();
    expect(state.finalStatus).toBe("human");
    expect(state.repairPasses).toBe(0);
    expect(state.reviewRouting?.outcome).toBe("human-fallback");
  });

  it("a clean Astra review and Jev accept cannot override failed deterministic verification", async () => {
    config.verificationCommands = ['node -e "process.exit(require(\'fs\').readFileSync(\'a.txt\',\'utf8\').startsWith(\'baseline\')?0:1)"'];
    const state = await run();
    expect(state.baselineVerification?.passed).toBe(true);
    expect(state.verification?.passed).toBe(false);
    expect(state.finalStatus).toBe("human");
    expect(state.repairPasses).toBe(DEFAULT_CONFIG.maxRepairPasses);
    expect(state.reviewRouting?.outcome).toBe("human-fallback");
    expect(state.sourceDisposition?.disposition).toBe("retained-unaccepted");
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

  it("crosses sequential scope snapshots when the runtime prefix is Git-ignored, even with a failing clean filter", async () => {
    // Reproduce the real host setup: the run root is ignored locally, while
    // runtime content is also covered by a required clean filter that must
    // never be invoked by scope snapshot capture.
    writeFileSync(join(cwd, ".git", "info", "exclude"), ".pi/software-factory/runs/\n");
    writeFileSync(join(cwd, ".git", "info", "attributes"), ".pi/software-factory/runs/** filter=fail\n");
    await git(cwd, "config", "filter.fail.clean", 'node -e "process.exit(1)"');
    await git(cwd, "config", "filter.fail.required", "true");

    const state = await run();

    expect(workerCalls).toBeGreaterThan(0);
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
