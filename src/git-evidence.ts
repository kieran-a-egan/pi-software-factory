import { execFile as execFileCallback } from "node:child_process";
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
 * (not Git globs). Only individually selected paths outside those boundaries
 * are staged in the scratch index. All prefixes also filter the final diff
 * and stat, so tracked paths under them produce no evidence or false deletions.
 *
 * Paths tracked in the real index (e.g. staged with `git add -f` despite
 * .gitignore, or staged before a new ignore rule landed) are part of the
 * implementation and are force-added into the scratch snapshot; ordinarily
 * ignored untracked files remain excluded.
 *
 * Ordinary untracked candidates honor Git's own ignore rules via `ls-files`.
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

    const prefixes = ignoredPrefixes.map(normalizePath).filter(Boolean);
    const exclusions = prefixes.map(exclusionPathspec);
    const baselineFiles = new Set(
      (await git(repoRoot, ["ls-tree", "-r", "-z", "--name-only", baseline], env, false))
        .split("\0").filter(Boolean),
    );
    const realIndexFiles = (await git(repoRoot, ["ls-files", "-z"], withoutIndexEnv(), false))
      .split("\0").filter(Boolean);
    const untrackedFiles = (await git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...exclusions], withoutIndexEnv(), false))
      .split("\0").filter(Boolean);

    // Seed the scratch index from the immutable baseline. Excluded tracked
    // paths retain their baseline entries; included deletions are staged below.
    await git(repoRoot, ["read-tree", baseline], env);

    // File-level, literal pathspecs avoid both ignored exclusion pathspec errors
    // and traversing excluded tracked/embedded content. The untracked listing
    // also excludes these paths before returning candidates. A NUL-delimited file
    // avoids argv limits and Git's glob/pathspec interpretation of filenames.
    const stage = async (paths: string[], force = false) => {
      if (paths.length === 0) return;
      const pathspecFile = join(tempRoot, "pathspecs");
      writeFileSync(pathspecFile, `${paths.map((path) => `:(top,literal)${path}`).join("\0")}\0`);
      await git(repoRoot, ["add", "-A", ...(force ? ["-f"] : []), `--pathspec-from-file=${pathspecFile}`, "--pathspec-file-nul"], env);
    };
    await stage([...new Set([...baselineFiles, ...untrackedFiles])]
      .filter((path) => !isUnderPrefixes(path, prefixes)));

    // Newly tracked real-index files aren't in the baseline or the untracked
    // listing. Force-add only these explicit paths (including git add -f files);
    // an index-only file since removed from disk is not part of the worktree.
    await stage(realIndexFiles.filter((path) => !baselineFiles.has(path)
      && !isUnderPrefixes(path, prefixes)
      && lstatSync(join(repoRoot, path), { throwIfNoEntry: false })), true);

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
