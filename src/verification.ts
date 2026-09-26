import { exec as execCallback, execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { captureGitEvidence } from "./git-evidence.js";
import type { VerificationResult } from "./types.js";

const exec = promisify(execCallback);
const execFile = promisify(execFileCallback);

async function run(command: string, cwd: string): Promise<{ passed: boolean; exitCode: number | null; output: string }> {
  try {
    const { stdout, stderr } = await exec(command, {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return { passed: true, exitCode: 0, output: `${stdout}${stderr}`.trim() };
  } catch (error: any) {
    return {
      passed: false,
      exitCode: typeof error?.code === "number" ? error.code : null,
      output: `${error?.stdout ?? ""}${error?.stderr ?? ""}${error?.message ? `\n${error.message}` : ""}`.trim(),
    };
  }
}

export async function gitStatus(cwd: string, ignoredPrefixes: string[] = []): Promise<string> {
  const exclusions = ignoredPrefixes
    .map((path) => path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, ""))
    .filter(Boolean)
    .map((path) => `:(top,literal,exclude)${path}`);
  const { stdout } = await execFile("git", ["status", "--short", "--untracked-files=all", "--", ...exclusions], {
    cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  // Let Git exclude paths before quoting/rename formatting; never parse human
  // status lines or trim their significant leading index/worktree columns.
  return stdout.trimEnd();
}

export async function verify(
  cwd: string,
  commands: string[],
  ignoredStatusPrefixes: string[] = [],
): Promise<VerificationResult> {
  const checks: VerificationResult["checks"] = [];
  for (const command of ["git diff --check", ...commands]) {
    const result = await run(command, cwd);
    checks.push({ command, ...result });
  }

  const status = await gitStatus(cwd, ignoredStatusPrefixes).catch((error) => `git status failed: ${error.message}`);

  let diff: string;
  let diffStat: string;
  try {
    // The scratch-index helper includes untracked files, honors Git ignore
    // rules, and applies the explicit prefix exclusions to both sides of the
    // comparison. Successful output is preserved verbatim (no trimming).
    const evidence = await captureGitEvidence(cwd, ignoredStatusPrefixes);
    diff = evidence.diff;
    diffStat = evidence.diffStat;
  } catch (error) {
    // A capture failure is reported as explicit diagnostics in the evidence
    // fields. It never throws out of verify(), never changes checks/passed,
    // and never falls back to tracked-only evidence.
    const e = error as { stdout?: unknown; stderr?: unknown; message?: unknown } | null;
    const details: string[] = [];
    if (e?.stdout) details.push(String(e.stdout));
    if (e?.stderr) details.push(String(e.stderr));
    const message = e?.message ?? (error == null ? "unknown error" : String(error));
    const diagnostic = [`git evidence capture failed: ${message}`, ...details].join("\n").trim();
    diff = diagnostic;
    diffStat = diagnostic;
  }

  return {
    passed: checks.every((x) => x.passed),
    checks,
    gitStatus: status,
    diffStat,
    diff,
  };
}
