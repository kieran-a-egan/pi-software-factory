import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Result of capturing the current worktree as lossless Git evidence.
 *
 * `diff` is the raw `git diff` stdout, preserved verbatim (including its final
 * newline). `diffStat` is the corresponding deterministic `git diff --stat`
 * output. Both are derived from the exact same baseline/captured tree pair.
 */
export interface GitEvidence {
  diff: string;
  diffStat: string;
}

export interface CaptureGitEvidenceOptions {
  /**
   * Optional base directory under which the scratch index is created. When
   * omitted the OS temporary directory is used. The per-invocation scratch
   * root created inside the base directory is always removed by this helper;
   * when a base directory is supplied it is left for the caller to manage.
   * Tests use this to observe exactly this invocation's scratch resources.
   */
  scratchBaseDir?: string;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

/**
 * Literal repository-relative file/directory boundary check. Prefixes are NOT
 * Git glob patterns: `runtime[1]` matches only the path `runtime[1]` (and
 * everything beneath it), never `runtime1` or `runtimeX`.
 */
function isUnderPrefixes(path: string, prefixes: string[]): boolean {
  return prefixes.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/**
 * Top-level, literal, exclude pathspec. `literal` disables glob/metacharacter
 * interpretation of the prefix, `top` pins it to the repository root, and
 * `exclude` keeps it out of the pathspec selection without removing tracked
 * baseline entries (which would fabricate deletion evidence).
 */
function exclusionPathspec(prefix: string): string {
  return `:(top,literal,exclude)${prefix}`;
}

/**
 * Best-effort recursive removal with a small bounded retry loop. On Windows a
 * just-killed Git child process can hold file handles briefly, making an
 * immediate `rmSync` fail with EPERM; retry a few times, then give up
 * (leaking the scratch directory) rather than throwing from `finally` and
 * masking the caller's real error.
 */
function removeWithRetry(path: string, attempts = 8): void {
  for (let i = 0; ; i++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      if (i >= attempts - 1) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function withIndexEnv(indexPath: string): NodeJS.ProcessEnv {
  // Redirect the index so the real repository index is never touched. All other
  // environment is inherited so git behaves as it would in the caller's shell.
  return { ...process.env, GIT_INDEX_FILE: indexPath };
}

function withoutIndexEnv(): NodeJS.ProcessEnv {
  // Explicitly read the REAL repository index, even if the caller's process
  // happens to carry a GIT_INDEX_FILE.
  const env = { ...process.env };
  delete env.GIT_INDEX_FILE;
  return env;
}

async function git(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  trimOutput = true,
): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd,
    env,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  return trimOutput ? stdout.trim() : stdout;
}

/**
 * Run a git command that consumes stdin (used to mint the empty tree object
 * hash via `git mktree`). The callback form exposes the child process so we can
 * drive stdin and then close it to signal EOF.
 */
function gitWithStdin(
  cwd: string,
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFileCallback("git", args, { cwd, env, maxBuffer: MAX_BUFFER, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
    const stdin = child.stdin;
    if (!stdin) {
      reject(new Error("git stdin unavailable"));
      return;
    }
    stdin.on("error", () => {
      // EPIPE is benign if git stops reading before we finish writing.
    });
    stdin.write(input);
    stdin.end();
  });
}

/**
 * Resolve the immutable baseline object ID exactly once.
 *
 * A repository whose HEAD resolves to a commit returns that commit's object
 * ID: every subsequent command (read-tree, both diffs) shares the exact same
 * captured baseline instead of re-resolving a symbolic ref.
 *
 * A valid but unborn branch (branch ref present, ref file absent, no commit)
 * is the only case allowed to fall back to the empty tree, so we never require
 * an initial commit. Every other resolution failure — detached HEAD without a
 * commit, or a branch ref pointing at a missing/corrupt commit — is reported
 * as an explicit error instead of silently diffing against an empty tree.
 */
async function resolveBaselineTree(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    return await git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"], env);
  } catch {
    // HEAD does not resolve to a commit. Only a positively identified unborn
    // branch may use the empty-tree baseline.
    let branch = "";
    try {
      branch = await git(cwd, ["symbolic-ref", "-q", "HEAD"], env);
    } catch {
      throw new Error(
        "git evidence: cannot resolve baseline: HEAD is neither a commit nor a branch ref",
      );
    }
    // `branch` is already a full ref name (e.g. `refs/heads/main`). Query it
    // exactly as-is: an unborn branch yields an empty listing, while a branch
    // whose ref points at a missing object makes `for-each-ref` fail (on this
    // Git version) or list the ref (on others) — both must be reported as an
    // explicit resolution error, never as an unborn repository.
    // `for-each-ref` treats its ref argument as a prefix filter, so request
    // canonical ref names and compare them exactly. A nested ref such as
    // refs/heads/main/foo must not make an unborn refs/heads/main look present.
    let refListing = "";
    try {
      refListing = await git(
        cwd,
        ["for-each-ref", "--format=%(refname)", branch],
        env,
      );
    } catch {
      throw new Error(
        `git evidence: cannot resolve baseline: branch '${branch}' ref is corrupt (missing or unreadable object)`,
      );
    }

    const exactRefExists = refListing
      .split(/\r?\n/)
      .some((ref) => ref.trim() === branch);

    if (exactRefExists) {
      throw new Error(
        `git evidence: cannot resolve baseline: branch '${branch}' exists but HEAD does not resolve to a commit (missing or corrupt ref)`,
      );
    }
    return (await gitWithStdin(cwd, ["mktree"], "", env)).trim();
  }
}

/**
 * Capture the current worktree as lossless Git evidence using a temporary,
 * isolated index.
 *
 * Safety guarantees:
 * - A scratch `GIT_INDEX_FILE` is used for every scratch-index git command;
 *   the real index is only ever read (via `ls-files`), never staged into or
 *   mutated.
 * - The scratch index is seeded from one captured immutable baseline object ID,
 *   current changes are staged, and a tree is written with `write-tree` (no
 *   commit is ever created).
 * - The temporary index directory is removed on both success and failure.
 *
 * `ignoredPrefixes` are literal repository-relative file/directory boundaries
 * (not Git globs). They are applied as `:(top,literal,exclude)` pathspecs:
 *   - during capture (`git add`), so excluded content is never processed by
 *     Git — a failing clean filter or an embedded repository beneath an
 *     excluded prefix cannot break the whole capture, and excluded untracked
 *     content is never written into the object database;
 *   - on both sides of the final baseline/captured comparison, so a modified
 *     or deleted tracked path beneath an ignored prefix produces no evidence
 *     and, critically, no false deletion (the seed retains its baseline
 *     entry).
 *
 * Paths tracked in the real index (e.g. staged with `git add -f` despite
 * .gitignore, or staged before a new ignore rule landed) are part of the
 * implementation and are force-added into the scratch snapshot; ordinarily
 * ignored untracked files remain excluded.
 *
 * Ordinary untracked files continue to honor Git's own ignore rules during the
 * staging step.
 *
 * Rejects (after cleanup) on any Git error or stdout buffer overflow; it never
 * returns a partial or synthesized patch.
 */
export async function captureGitEvidence(
  cwd: string,
  ignoredPrefixes: string[] = [],
  options: CaptureGitEvidenceOptions = {},
): Promise<GitEvidence> {
  const baseDir = options.scratchBaseDir ?? tmpdir();
  const tempRoot = mkdtempSync(join(baseDir, "pi-sf-evidence-"));
  const indexPath = join(tempRoot, "index");
  const env = withIndexEnv(indexPath);

  try {
    const repoRoot = await git(cwd, ["rev-parse", "--show-toplevel"], env);
    const baseline = await resolveBaselineTree(repoRoot, env);

    // Build the literal exclusions before any capture step so every Git
    // command below can apply them.
    const prefixes = ignoredPrefixes.map(normalizePath).filter(Boolean);
    const exclusions = prefixes.map(exclusionPathspec);

    // Seed the scratch index from the immutable baseline so deletions of
    // tracked files are visible, and excluded tracked paths keep their
    // baseline entries (avoiding false deletions in the comparison).
    await git(repoRoot, ["read-tree", baseline], env);

    // Stage the full current worktree with the exclusions applied during
    // capture. Excluded paths are left untouched in the scratch index.
    await git(repoRoot, ["add", "-A", "--", ".", ...exclusions], env);

    // Real-index-tracked paths that are absent from the baseline and would be
    // skipped by the staging pass because they match an ignore rule (force-
    //added files, or files staged before they became ignored) are captured
    // explicitly. Baseline-tracked paths need no special handling: ignore
    // rules never apply to tracked content, so the `add -A` pass already
    // covers them (including deletions).
    const realIndexFiles = (await git(repoRoot, ["ls-files", "-z"], withoutIndexEnv()))
      .split("\0")
      .filter(Boolean);
    if (realIndexFiles.length > 0) {
      const baselineFiles = new Set(
        (await git(repoRoot, ["ls-tree", "-r", "-z", "--name-only", baseline], env))
          .split("\0")
          .filter(Boolean),
      );
      const toForce = realIndexFiles.filter(
        (path) => !baselineFiles.has(path) && !isUnderPrefixes(path, prefixes),
      );
      const present = toForce.filter((path) => existsSync(join(repoRoot, path)));
      if (present.length > 0) {
        await git(repoRoot, ["add", "-A", "-f", "--", ...present], env);
      }
    }

    const capturedTree = await git(repoRoot, ["write-tree"], env);

    // The same baseline/tree pair and the same literal exclusions are used for
    // both outputs.
    const diffArgs = [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--no-color",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      baseline,
      capturedTree,
    ];
    const statArgs = [
      "diff",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--no-color",
      "--stat",
      baseline,
      capturedTree,
    ];
    if (exclusions.length > 0) {
      diffArgs.push("--", ...exclusions);
      statArgs.push("--", ...exclusions);
    }

    const diff = await git(repoRoot, diffArgs, env, false);
    const diffStat = await git(repoRoot, statArgs, env, false);

    return { diff, diffStat };
  } finally {
    removeWithRetry(tempRoot);
  }
}
