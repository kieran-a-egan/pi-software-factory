import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { captureGitEvidence } from "./git-evidence.js";
import type { VerificationResult } from "./types.js";

const exec = promisify(execCallback);

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

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function filterStatus(output: string, ignoredPrefixes: string[]): string {
  const prefixes = ignoredPrefixes.map(normalizePath).filter(Boolean);
  if (prefixes.length === 0 || !output.trim()) return output.trim();

  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      const path = normalizePath(line.length > 3 ? line.slice(3).trim().replace(/^"|"$/g, "") : line.trim());
      return !prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
    })
    .join("\n");
}

export async function gitStatus(cwd: string, ignoredPrefixes: string[] = []): Promise<string> {
  return filterStatus((await run("git status --short --untracked-files=all", cwd)).output, ignoredPrefixes);
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

  const status = await run("git status --short --untracked-files=all", cwd);

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
    gitStatus: filterStatus(status.output, ignoredStatusPrefixes),
    diffStat,
    diff,
  };
}
