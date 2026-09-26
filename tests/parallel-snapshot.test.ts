import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkingTreeSnapshot } from "../src/parallel.js";

const exec = promisify(execFile);
const repos: string[] = [];

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-sf-snapshot-test-"));
  repos.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })).stdout;
}

function write(cwd: string, path: string, content: string): void {
  const target = join(cwd, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

async function initRepo(cwd: string): Promise<void> {
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.name", "Test"]);
  await git(cwd, ["config", "user.email", "test@local.invalid"]);
  await git(cwd, ["config", "commit.gpgsign", "false"]);
  await git(cwd, ["config", "core.autocrlf", "false"]);
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-m", message]);
}

function names(value: string): string[] {
  return value.split(/\r?\n/).filter(Boolean).sort();
}

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe("createWorkingTreeSnapshot", () => {
  it("captures included changes when the excluded runtime prefix is Git-ignored and leaves the real index untouched", async () => {
    const cwd = tempRepo();
    await initRepo(cwd);

    write(cwd, "src/app.txt", "before\n");
    write(cwd, ".pi/software-factory/runs/tracked.txt", "before\n");
    await commitAll(cwd, "baseline");

    // Match a common developer setup where factory runtime artifacts are
    // ignored through local repository configuration rather than .gitignore.
    writeFileSync(
      join(cwd, ".git", "info", "exclude"),
      ".pi/software-factory/runs/\n",
      "utf8",
    );

    write(cwd, "src/app.txt", "after\n");
    write(cwd, ".pi/software-factory/runs/tracked.txt", "runtime after\n");
    write(cwd, ".pi/software-factory/runs/untracked.txt", "runtime only\n");
    const indexBefore = readFileSync(join(cwd, ".git", "index"));

    const snapshot = await createWorkingTreeSnapshot(
      cwd,
      [".pi/software-factory/runs"],
    );

    const changed = await git(cwd, [
      "diff",
      "--name-only",
      "--no-renames",
      "HEAD",
      snapshot,
    ]);
    expect(names(changed)).toEqual(["src/app.txt"]);
    expect(readFileSync(join(cwd, ".git", "index"))).toEqual(indexBefore);
  });

  it("never runs clean filters on tracked files beneath an ignored excluded prefix", async () => {
    const cwd = tempRepo();
    await initRepo(cwd);

    write(cwd, ".gitignore", "runtime/\n");
    write(cwd, "src/app.txt", "before\n");
    write(cwd, "runtime/tracked.txt", "before\n");
    await git(cwd, ["add", ".gitignore", "src/app.txt"]);
    await git(cwd, ["add", "-f", "runtime/tracked.txt"]);
    await git(cwd, ["commit", "-m", "baseline"]);

    writeFileSync(
      join(cwd, ".git", "info", "attributes"),
      "runtime/tracked.txt filter=fail\n",
      "utf8",
    );
    await git(cwd, ["config", "filter.fail.clean", 'node -e "process.exit(1)"']);
    await git(cwd, ["config", "filter.fail.required", "true"]);

    write(cwd, "src/app.txt", "after\n");
    write(cwd, "runtime/tracked.txt", "runtime after\n");

    const snapshot = await createWorkingTreeSnapshot(cwd, ["runtime"]);
    const changed = await git(cwd, [
      "diff",
      "--name-only",
      "--no-renames",
      "HEAD",
      snapshot,
    ]);

    expect(names(changed)).toEqual(["src/app.txt"]);
  });

  it("includes files deliberately force-tracked in the real index outside excluded prefixes", async () => {
    const cwd = tempRepo();
    await initRepo(cwd);

    write(cwd, ".gitignore", "secret/\n");
    write(cwd, "base.txt", "base\n");
    await commitAll(cwd, "baseline");

    write(cwd, "secret/plan.txt", "staged ignored version\n");
    await git(cwd, ["add", "-f", "secret/plan.txt"]);
    write(cwd, "secret/plan.txt", "current worktree version\n");
    const indexBefore = readFileSync(join(cwd, ".git", "index"));

    const snapshot = await createWorkingTreeSnapshot(cwd);
    const diff = await git(cwd, [
      "diff",
      "--binary",
      "--no-renames",
      "HEAD",
      snapshot,
    ]);

    expect(diff).toContain("secret/plan.txt");
    expect(diff).toContain("+current worktree version");
    expect(readFileSync(join(cwd, ".git", "index"))).toEqual(indexBefore);
  });
});
