import { execFile as execFileCallback } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

async function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  trimOutput = true,
): Promise<string> {
  const { stdout, stderr } = await execFile("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (stderr?.trim()) {
    // Git writes benign progress messages to stderr for some commands. Callers
    // only need stdout and rely on execFile rejection for non-zero exit codes.
  }
  return trimOutput ? stdout.trim() : stdout;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function snapshotIdentityEnv(): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: "Pi Software Factory",
    GIT_AUTHOR_EMAIL: "software-factory@local.invalid",
    GIT_COMMITTER_NAME: "Pi Software Factory",
    GIT_COMMITTER_EMAIL: "software-factory@local.invalid",
  };
}

export interface IsolatedWorktree {
  dir: string;
  root: string;
}

export interface CapturedWorktreeChange {
  snapshotCommit: string;
  changedPaths: string[];
  patch: string;
}

export async function createWorkingTreeSnapshot(
  cwd: string,
  ignoredPrefixes: string[] = [],
): Promise<string> {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-sf-index-"));
  const indexPath = join(tempRoot, "index");
  const env: NodeJS.ProcessEnv = {
    ...snapshotIdentityEnv(),
    GIT_INDEX_FILE: indexPath,
  };

  try {
    await git(cwd, ["read-tree", "HEAD"], env);
    await git(cwd, ["add", "-A", "--", "."], env);

    for (const rawPrefix of ignoredPrefixes) {
      const prefix = normalizePath(rawPrefix);
      if (!prefix) continue;
      await git(cwd, ["rm", "-r", "--cached", "--ignore-unmatch", "--", prefix], env);
    }

    const tree = await git(cwd, ["write-tree"], env);
    return await git(
      cwd,
      ["commit-tree", tree, "-p", "HEAD", "-m", "pi-software-factory parallel snapshot"],
      env,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export async function createIsolatedWorktree(
  cwd: string,
  snapshotCommit: string,
  label: string,
): Promise<IsolatedWorktree> {
  const safeLabel = label.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 48) || "unit";
  const root = mkdtempSync(join(tmpdir(), `pi-sf-${safeLabel}-`));
  const dir = join(root, "repo");

  try {
    await git(cwd, ["worktree", "add", "--detach", dir, snapshotCommit]);
    return { dir, root };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export async function removeIsolatedWorktree(
  cwd: string,
  worktree: IsolatedWorktree,
): Promise<void> {
  try {
    await git(cwd, ["worktree", "remove", "--force", worktree.dir]);
  } catch {
    // Best effort cleanup continues below. A later git worktree prune can remove
    // stale administrative metadata if the directory disappeared unexpectedly.
  } finally {
    rmSync(worktree.root, { recursive: true, force: true });
  }
}

export async function captureWorktreeChange(
  worktreeDir: string,
  baseSnapshotCommit: string,
  ignoredPrefixes: string[] = [],
): Promise<CapturedWorktreeChange> {
  const snapshotCommit = await createWorkingTreeSnapshot(worktreeDir, ignoredPrefixes);
  const changed = await git(
    worktreeDir,
    ["diff", "--name-only", "--no-renames", baseSnapshotCommit, snapshotCommit],
  );
  const patch = await git(
    worktreeDir,
    ["diff", "--binary", "--no-ext-diff", "--no-renames", baseSnapshotCommit, snapshotCommit],
    undefined,
    false,
  );

  return {
    snapshotCommit,
    changedPaths: changed
      .split(/\r?\n/)
      .map(normalizePath)
      .filter(Boolean),
    patch,
  };
}

export async function applyWorktreePatches(cwd: string, patches: string[]): Promise<void> {
  const nonEmpty = patches.filter((patch) => patch.length > 0 && patch.trim().length > 0);
  if (nonEmpty.length === 0) return;

  const tempRoot = mkdtempSync(join(tmpdir(), "pi-sf-patches-"));
  const patchPaths = nonEmpty.map((patch, index) => {
    const patchPath = join(tempRoot, `change-${String(index + 1).padStart(3, "0")}.patch`);
    writeFileSync(patchPath, patch, "utf8");
    return patchPath;
  });

  try {
    await git(cwd, ["apply", "--check", "--whitespace=nowarn", "--recount", ...patchPaths]);
    await git(cwd, ["apply", "--whitespace=nowarn", "--recount", ...patchPaths]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function pathsOverlap(a: string, b: string): boolean {
  const left = normalizePath(a);
  const right = normalizePath(b);
  if (!left || !right) return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function changedPathsOutsideExpected(
  changedPaths: string[],
  filesExpected?: string[],
): string[] {
  if (!filesExpected?.length) return changedPaths.map(normalizePath);

  const expected = filesExpected.map(normalizePath);
  return changedPaths
    .map(normalizePath)
    .filter((path) => !expected.some((allowed) => pathsOverlap(path, allowed)));
}
