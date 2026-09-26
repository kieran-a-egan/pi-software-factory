import { execFile as execFileCallback } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { captureGitEvidence } from "./git-evidence.js";
import type { RunStore } from "./storage.js";

const execFile = promisify(execFileCallback);
async function git(cwd: string, args: string[]): Promise<string> {
  const env = { ...process.env };
  delete env.GIT_INDEX_FILE;
  return (await execFile("git", args, { cwd, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout;
}

/** Read-only source/index evidence. Runtime paths are literal exclusions throughout. */
async function captureSourceState(cwd: string, ignoredPrefixes: string[]) {
  const exclusions = ignoredPrefixes.map((path) => `:(top,literal,exclude)${path.replace(/\\/g, "/").replace(/\/$/, "")}`);
  const evidence = await captureGitEvidence(cwd, ignoredPrefixes);
  const head = await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]).catch((error) => {
    if (error.code === 1) return ""; // captureGitEvidence already validates an unborn HEAD.
    throw error;
  });
  return {
    head: head.trim(),
    status: await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...exclusions]),
    stagedDiff: await git(cwd, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--", ...exclusions]),
    ...evidence,
  };
}

export interface RunSafetyEvidence {
  disposition: "active-unaccepted" | "unchanged" | "accepted-in-place" | "retained-unaccepted" | "unknown-retained";
  lockPath: string;
  runDir: string;
  error?: string;
}

/**
 * An in-place transaction journal, not an automatic rollback. On failure we
 * retain all source bytes and interlock subsequent runs for human disposition.
 * A crash leaves the exclusive lock and active journal behind. Never reclaim
 * a lock using PID/age heuristics: only a human can decide the prior run is over.
 */
export async function reserveRun(cwd: string, store: RunStore) {
  const gitDir = (await git(cwd, ["rev-parse", "--absolute-git-dir"])).trim();
  const lockPath = join(gitDir, "pi-software-factory.lock");
  const evidence: RunSafetyEvidence = { disposition: "active-unaccepted", lockPath, runDir: store.dir };
  try {
    writeFileSync(lockPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`Factory source safety interlock: ${lockPath}. Inspect the previous run and dispose of its unaccepted edits before manually removing this lock. ${readFileSync(lockPath, "utf8")}`);
  }

  let before: Awaited<ReturnType<typeof captureSourceState>> | undefined;
  return {
    evidence,
    async begin(ignoredPrefixes: string[]) {
      store.write("source-disposition.json", evidence);
      before = await captureSourceState(cwd, ignoredPrefixes);
      store.write("source-before.json", before);
    },
    async conclude(input: { accepted: boolean; verifiedDiff?: string; writerQuiescenceUncertain: boolean }, ignoredPrefixes: string[], retainedWorktrees: string[]) {
      try {
        const after = await captureSourceState(cwd, ignoredPrefixes);
        store.write("source-after.json", after);
        if (!before) throw new Error("Initial source evidence unavailable.");
        if (input.writerQuiescenceUncertain) {
          throw new Error("Worker cancellation/failure requires human confirmation that all source-writing processes have stopped.");
        }
        if (after.head !== before.head) throw new Error("HEAD changed during the run; history requires human inspection.");
        if (retainedWorktrees.length) throw new Error(`Isolated worktrees retained for inspection: ${retainedWorktrees.join(", ")}`);
        if (input.accepted && after.diff !== input.verifiedDiff) {
          throw new Error("Source changed after authoritative verification or verification evidence was unavailable.");
        }
        evidence.disposition = input.accepted ? "accepted-in-place"
          : JSON.stringify(before) === JSON.stringify(after) ? "unchanged" : "retained-unaccepted";
      } catch (error: any) {
        evidence.disposition = "unknown-retained";
        evidence.error = error?.message ?? String(error);
      }
      return { ...evidence };
    },
    release() {
      // Called only AFTER terminal state/summary persistence. Failed writes or
      // process termination deliberately leave the interlock in place.
      if (evidence.disposition === "unchanged" || evidence.disposition === "accepted-in-place") unlinkSync(lockPath);
    },
  };
}
