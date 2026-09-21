import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
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

export async function gitStatus(cwd: string): Promise<string> {
  return (await run("git status --short", cwd)).output;
}

export async function verify(cwd: string, commands: string[]): Promise<VerificationResult> {
  const checks: VerificationResult["checks"] = [];
  for (const command of ["git diff --check", ...commands]) {
    const result = await run(command, cwd);
    checks.push({ command, ...result });
  }

  const status = await run("git status --short", cwd);
  const stat = await run("git diff --stat", cwd);
  const diff = await run("git diff --no-ext-diff", cwd);

  return {
    passed: checks.every((x) => x.passed),
    checks,
    gitStatus: status.output,
    diffStat: stat.output,
    diff: diff.output,
  };
}
