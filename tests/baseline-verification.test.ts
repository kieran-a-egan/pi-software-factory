/**
 * Deterministic coverage for the persisted pre-model baseline gate in
 * runFactory (src/controller.ts):
 *
 * - ordering: clean-tree preflight → baseline verification and persistence →
 *   baseline routing → API-key gate and model initialization,
 * - persistence: baseline-verification.json, state.json, the returned state,
 *   and run-summary.json telemetry agree,
 * - exclusions: an in-repository run root's own dirty/untracked runtime
 *   artifacts are excluded from baseline status and evidence exactly as a
 *   plain verify() call with the same prefix reports them,
 * - passed semantics: only verify()'s checks drive baseline failure; evidence
 *   capture diagnostics do not,
 * - downstream absence: a failing baseline performs no model work of any kind.
 *
 * Everything is hermetic: temporary Git repositories with local identity,
 * portable Node-based verification commands, environment variables and spies
 * restored after every test, and no real models or network access.
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config.js";
import { runFactory } from "../src/controller.js";
import * as gitEvidence from "../src/git-evidence.js";
import { verify } from "../src/verification.js";
import type { FactoryConfig, FactoryRunState } from "../src/types.js";

const execFileP = promisify(execFile);

async function g(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/**
 * Hermetic repository: local identity so it never depends on (or leaks) the
 * machine's global config, plus deterministic line endings.
 */
async function initRepo(dir: string): Promise<void> {
  await g(dir, ["init", "-b", "main"]);
  await g(dir, ["config", "user.name", "Baseline Test"]);
  await g(dir, ["config", "user.email", "baseline@test.local"]);
  await g(dir, ["config", "commit.gpgsign", "false"]);
  await g(dir, ["config", "core.autocrlf", "false"]);
}

function write(dir: string, rel: string, data: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data, "utf8");
}

async function commitAll(dir: string, message: string): Promise<void> {
  await g(dir, ["add", "-A"]);
  await g(dir, ["commit", "-m", message]);
}

const tempDirs: string[] = [];
function tempDir(prefix = "pi-sf-baseline-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function removeDirBestEffort(path: string, attempts = 10): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      if (i >= attempts - 1) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

// Cleanup runs unconditionally after every test, including assertion failures.
afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeDirBestEffort(dir);
  }
});

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = savedKey;
  vi.restoreAllMocks();
});

/** Clean committed fixture; every tracked byte is whitespace-clean. */
async function initCleanRepo(dir: string): Promise<void> {
  await initRepo(dir);
  write(dir, "src/app.js", "app v1\n");
  write(dir, "docs/notes.txt", "baseline note\n");
  await commitAll(dir, "baseline");
}

/** Run a factory against a repo; returns the state plus the run directory. */
async function runFactoryIn(
  cwd: string,
  configOverrides: Partial<FactoryConfig>,
): Promise<{ state: FactoryRunState; runDir: string }> {
  const config: FactoryConfig = { ...structuredClone(DEFAULT_CONFIG), ...configOverrides };
  const state = await runFactory(cwd, "deterministic baseline gate test", config, () => undefined);
  const runDir = join(cwd, config.runRoot, state.id);
  return { state, runDir };
}

function readJson(runDir: string, name: string): any {
  return JSON.parse(readFileSync(join(runDir, name), "utf8"));
}

/** Portable Node-based verification commands (no shell-specific constructs). */
const PASS_CMD = 'node -e "console.log(\'baseline-ok\')"';
const FAIL_A_CMD = 'node -e "console.error(\'baseline-fail-a\'); process.exit(3)"';
const FAIL_B_CMD = 'node -e "console.error(\'baseline-fail-b\'); process.exit(5)"';
const MARKER_CMD = 'node -e "require(\'fs\').writeFileSync(\'baseline-marker.txt\', \'marker\')"';

describe("runFactory baseline verification gate", () => {
  it("persists a passing baseline and continues to the API-key sentinel without any model access", async () => {
    const dir = tempDir();
    await initCleanRepo(dir);

    const { state, runDir } = await runFactoryIn(dir, { verificationCommands: [PASS_CMD] });

    // Reached the existing key gate — proof the run continued past baseline.
    expect(state.finalStatus).toBe("blocked");
    expect(state.finalReason).toBe("TYPESAFE_API_KEY is not set.");

    // Stage ordering: preflight first, then baseline, nothing else.
    expect((state.telemetry ?? []).map((stage) => stage.stage)).toEqual(["preflight", "baseline-verify"]);
    expect((state.telemetry ?? [])[0].actor).toBe("controller");
    expect((state.telemetry ?? [])[1].actor).toBe("tools");
    for (const stage of state.telemetry ?? []) expect(stage.outcome).toBe("completed");

    // Returned state carries the passing baseline.
    expect(state.baselineVerification?.passed).toBe(true);
    expect(state.baselineVerification?.checks.map((c) => c.command)).toEqual(["git diff --check", PASS_CMD]);
    expect(state.baselineVerification?.checks.every((c) => c.passed && c.exitCode === 0)).toBe(true);

    // Artifact, returned state, and persisted state all agree.
    const artifact = readJson(runDir, "baseline-verification.json");
    const persistedState = readJson(runDir, "state.json");
    expect(artifact).toEqual(state.baselineVerification);
    expect(persistedState.baselineVerification).toEqual(state.baselineVerification);
    expect(persistedState.finalReason).toBe("TYPESAFE_API_KEY is not set.");

    // The run summary's telemetry matches the stopped run: two stages only.
    const summary = readJson(runDir, "run-summary.json");
    expect(summary.finalReason).toBe("TYPESAFE_API_KEY is not set.");
    expect(summary.stages.map((stage: any) => stage.stage)).toEqual(["preflight", "baseline-verify"]);
  });

  // Two full runs include baseline and before/after safety captures; Windows CI
  // took 4,980ms on Node 22, leaving no headroom under Vitest's 5s default.
  it("stops on a failing baseline with the baseline-specific reason (not the key error) and never initializes a model even when a key is set", async () => {
    const dir = tempDir();
    await initCleanRepo(dir);

    // No key: the baseline failure must preempt the key gate, not mask as it.
    const first = await runFactoryIn(dir, { verificationCommands: [FAIL_A_CMD] });
    expect(first.state.finalStatus).toBe("blocked");
    expect(first.state.finalReason).toBe(
      `Repository baseline verification failed before implementation. Failed checks: ${FAIL_A_CMD}`,
    );
    expect(first.state.finalReason).not.toBe("TYPESAFE_API_KEY is not set.");
    expect(first.state.baselineVerification?.passed).toBe(false);

    // Dummy key with a fail-fast create spy: if the controller ever reached
    // model initialization, runFactory would reject instead of returning.
    process.env.TYPESAFE_API_KEY = "dummy-not-a-real-key";
    const createSpy = vi
      .spyOn(ModelRuntime, "create")
      .mockRejectedValue(new Error("baseline tests must not initialize a model"));

    let second: { state: FactoryRunState } | undefined;
    try {
      second = await runFactoryIn(dir, { verificationCommands: [FAIL_A_CMD] });
    } finally {
      delete process.env.TYPESAFE_API_KEY;
    }
    expect(second?.state.finalStatus).toBe("blocked");
    expect(second?.state.finalReason).toBe(
      `Repository baseline verification failed before implementation. Failed checks: ${FAIL_A_CMD}`,
    );
    expect(createSpy).not.toHaveBeenCalled();
  }, process.platform === "win32" ? 10_000 : 5_000);

  it("persists every configured command in order with exit codes and output, and lists all failed commands in the stop reason", async () => {
    const dir = tempDir();
    await initCleanRepo(dir);

    const { state, runDir } = await runFactoryIn(dir, {
      verificationCommands: [PASS_CMD, FAIL_A_CMD, FAIL_B_CMD],
    });

    expect(state.finalStatus).toBe("blocked");
    // Both failing commands are named in the reason, in check order.
    expect(state.finalReason).toBe(
      `Repository baseline verification failed before implementation. Failed checks: ${FAIL_A_CMD}, ${FAIL_B_CMD}`,
    );
    expect(state.baselineVerification?.passed).toBe(false);

    const checks = state.baselineVerification?.checks ?? [];
    expect(checks.map((c) => c.command)).toEqual(["git diff --check", PASS_CMD, FAIL_A_CMD, FAIL_B_CMD]);
    expect(checks.map((c) => c.passed)).toEqual([true, true, false, false]);
    expect(checks.map((c) => c.exitCode)).toEqual([0, 0, 3, 5]);
    expect(checks[1].output).toContain("baseline-ok");
    expect(checks[2].output).toContain("baseline-fail-a");
    expect(checks[3].output).toContain("baseline-fail-b");

    // Artifact, returned state, and persisted state agree on the failure.
    const artifact = readJson(runDir, "baseline-verification.json");
    const persistedState = readJson(runDir, "state.json");
    expect(artifact).toEqual(state.baselineVerification);
    expect(persistedState.baselineVerification).toEqual(state.baselineVerification);
    expect(persistedState.finalReason).toBe(state.finalReason);
  });

  it("excludes the in-repository run root's own runtime files from baseline status and evidence, matching plain verify() with the same prefix", async () => {
    const dir = tempDir();
    await initRepo(dir);
    // Whitespace-clean tracked runtime content committed under the run root,
    // so the exclusion must also produce no false deletion evidence for a
    // tracked baseline entry beneath the prefix (and `git diff --check`
    // cannot confound the fixture with a tracked change).
    write(dir, ".pi/software-factory/runs/runtime.log", "run 1\n");
    write(dir, "src/app.js", "app v1\n");
    await commitAll(dir, "baseline");

    // The dirty runtime state beneath the prefix mixes tracked and untracked
    // changes: a whitespace-clean tracked modification of runtime.log plus
    // untracked stray/run files. The leading-space ` M ` status form must be
    // excluded just as reliably as staged runtime artifacts.
    write(dir, ".pi/software-factory/runs/runtime.log", "run 2\n");
    write(dir, ".pi/software-factory/runs/aaa-seed.txt", "seed\n");

    const { state } = await runFactoryIn(dir, { verificationCommands: [PASS_CMD] });

    // The raw status shows the tracked modification plus the untracked
    // runtime artifacts, all under the prefix.
    const rawStatus = (await g(dir, ["status", "--short", "--untracked-files=all"])).trim();
    expect(rawStatus).toContain(".pi/software-factory/runs");
    expect(rawStatus).toContain("runtime.log");
    expect(rawStatus).toContain("aaa-seed.txt");
    expect(rawStatus).toContain(state.id);

    // The gate continued past baseline to the key sentinel.
    expect(state.finalReason).toBe("TYPESAFE_API_KEY is not set.");
    expect(state.baselineVerification?.passed).toBe(true);

    // Baseline status and evidence contain nothing beneath the run-root prefix,
    // including the tracked runtime.log modification.
    const baseline = state.baselineVerification!;
    expect(baseline.gitStatus).toBe("");
    expect(baseline.diff).not.toContain(".pi/software-factory/runs");
    expect(baseline.diff).not.toContain("runtime.log");
    expect(baseline.diff).not.toContain("run 2");
    expect(baseline.diff).not.toContain("aaa-seed.txt");
    expect(baseline.diffStat).not.toContain("runtime.log");
    // The tracked runtime file under the prefix yields no false deletion.
    expect(baseline.diff).not.toMatch(/deleted file[\s\S]*runtime\.log/);

    // A plain verify() with the same prefix reports identical status/evidence.
    const plain = await verify(dir, [PASS_CMD], [".pi/software-factory/runs"]);
    expect(baseline.gitStatus).toBe(plain.gitStatus);
    expect(baseline.diff).toBe(plain.diff);
    expect(baseline.diffStat).toBe(plain.diffStat);
    expect(baseline.passed).toBe(plain.passed);
    expect(baseline.checks).toEqual(plain.checks);
  });

  it("keeps the baseline passed when evidence capture alone fails, persisting the diagnostics and still reaching the key sentinel", async () => {
    const dir = tempDir();
    await initCleanRepo(dir);

    // Selective, test-only injection: only the evidence capture rejects; the
    // real checks (including `git diff --check`) still run and pass.
    const capture = gitEvidence.captureGitEvidence;
    const captureSpy = vi
      .spyOn(gitEvidence, "captureGitEvidence")
      .mockImplementationOnce(capture) // initial safety journal, before baseline
      .mockRejectedValueOnce(new Error("injected evidence capture failure"));

    const { state, runDir } = await runFactoryIn(dir, { verificationCommands: [PASS_CMD] });

    expect(captureSpy).toHaveBeenCalledTimes(3); // before, baseline, terminal safety evidence
    expect(state.finalStatus).toBe("blocked");
    expect(state.finalReason).toBe("TYPESAFE_API_KEY is not set.");

    const baseline = state.baselineVerification!;
    // passed derives from checks only; the capture failure must not change it.
    expect(baseline.passed).toBe(true);
    expect(baseline.checks.every((c) => c.passed && c.exitCode === 0)).toBe(true);
    // Diagnostics are persisted verbatim in both evidence fields.
    expect(baseline.diff).toContain("git evidence capture failed");
    expect(baseline.diff).toContain("injected evidence capture failure");
    expect(baseline.diffStat).toContain("git evidence capture failed");
    expect(baseline.diffStat).toContain("injected evidence capture failure");
    expect(readJson(runDir, "baseline-verification.json")).toEqual(baseline);
  });

  it("performs no downstream work when the baseline fails: only preflight and baseline telemetry, no downstream state or artifacts, zero counters, and an untouched repository", async () => {
    const dir = tempDir();
    await initCleanRepo(dir);

    const headBefore = await g(dir, ["rev-parse", "HEAD"]);
    const indexBefore = readFileSync(join(dir, ".git", "index"));
    const sourceBefore = readFileSync(join(dir, "src/app.js"));

    const { state, runDir } = await runFactoryIn(dir, { verificationCommands: [FAIL_A_CMD] });

    expect(state.finalStatus).toBe("blocked");
    expect(state.baselineVerification?.passed).toBe(false);

    // Telemetry contains exactly the two pre-model stages.
    expect((state.telemetry ?? []).map((stage) => stage.stage)).toEqual(["preflight", "baseline-verify"]);

    // Model-stage state is absent; continuation/checkpoint/worker collections
    // are absent or empty; all repair/planning counters remain zero.
    expect(state.intake).toBeUndefined();
    expect(state.scout).toBeUndefined();
    expect(state.architecture).toBeUndefined();
    expect(state.planGate).toBeUndefined();
    expect(state.workers).toBeUndefined();
    expect(state.workerGates).toBeUndefined();
    expect(state.checkpoints).toBeUndefined();
    expect(state.workerContinuations).toEqual([]);
    expect(state.parallelBatches).toEqual([]);
    expect(state.decisions).toEqual([]);
    expect(state.verification).toBeUndefined();
    expect(state.review).toBeUndefined();
    expect(state.reviewGate).toBeUndefined();
    expect(state.repairPasses).toBe(0);
    expect(state.rescoutPasses).toBe(0);
    expect(state.replanPasses).toBe(0);
    expect(state.planGatePasses).toBe(0);

    // Run directory holds only preflight, baseline, and bookkeeping artifacts:
    // no implementation, repair, verification, or review artifacts at all.
    const files = readdirSync(runDir).sort();
    expect(files).toEqual(
      [
        "baseline-verification.json",
        "preflight.json",
        "request.json",
        "run-summary.json",
        "source-before.json",
        "source-after.json",
        "source-disposition.json",
        "state.json",
        "telemetry.json",
      ].sort(),
    );

    // The run summary reports exactly the two pre-model stages.
    expect(readJson(runDir, "run-summary.json").stages.map((stage: any) => stage.stage)).toEqual([
      "preflight",
      "baseline-verify",
    ]);

    // Source contents, the real index, the worktree, and HEAD are unchanged;
    // the only visible Git activity is the run's own untracked runtime artifacts.
    expect(await g(dir, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(readFileSync(join(dir, ".git", "index"))).toEqual(indexBefore);
    expect(readFileSync(join(dir, "src/app.js"))).toEqual(sourceBefore);
    expect((await g(dir, ["diff"])).trim()).toBe("");
    expect((await g(dir, ["diff", "--cached"])).trim()).toBe("");
    const statusLines = (await g(dir, ["status", "--short", "--untracked-files=all"]))
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(statusLines.length).toBeGreaterThan(0);
    for (const line of statusLines) {
      expect(line).toMatch(/^\?\? \.pi\/software-factory\/runs\//);
    }
  });

  it("stops at preflight on a dirty tree when requireCleanWorkingTree is enabled, without a baseline artifact or configured-command execution", async () => {
    const dir = tempDir();
    await initCleanRepo(dir);
    // A genuine tracked modification makes the tree dirty.
    write(dir, "src/app.js", "app dirty\n");

    const { state, runDir } = await runFactoryIn(dir, {
      requireCleanWorkingTree: true,
      verificationCommands: [MARKER_CMD],
    });

    expect(state.finalStatus).toBe("blocked");
    expect(state.finalReason).toBe(
      "Working tree is not clean; factory is configured to require a clean tree.",
    );

    // No baseline stage ran at all.
    expect(state.baselineVerification).toBeUndefined();
    expect((state.telemetry ?? []).map((stage) => stage.stage)).toEqual(["preflight"]);
    expect(readdirSync(runDir)).not.toContain("baseline-verification.json");

    // The configured command demonstrably never executed.
    expect(readdirSync(dir)).not.toContain("baseline-marker.txt");

    // The preflight evidence did capture the dirty tracked change.
    expect(readJson(runDir, "preflight.json").gitStatus).toContain("src/app.js");
  });
});
