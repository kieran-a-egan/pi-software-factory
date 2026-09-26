import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { gitStatus, verify } from "../src/verification.js";

const execFileP = promisify(execFile);

async function g(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/**
 * Create a hermetic, disposable Git repository: local identity so it never
 * depends on (or leaks) the machine's global config, and deterministic
 * line-ending behavior so patch bytes are predictable on any platform.
 */
async function initRepo(dir: string): Promise<void> {
  await g(dir, ["init", "-b", "main"]);
  await g(dir, ["config", "user.name", "Verification Test"]);
  await g(dir, ["config", "user.email", "verification@test.local"]);
  await g(dir, ["config", "commit.gpgsign", "false"]);
  await g(dir, ["config", "core.autocrlf", "false"]);
}

function write(dir: string, rel: string, data: string): string {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data, "utf8");
  return abs;
}

async function commitAll(dir: string, message: string): Promise<void> {
  await g(dir, ["add", "-A"]);
  await g(dir, ["commit", "-m", message]);
}

const tempDirs: string[] = [];
function tempDir(prefix = "pi-sf-ver-test-"): string {
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
      if (i >= attempts - 1) {
        // A just-killed Git child can briefly hold handles on Windows; if the
        // retries exhaust, leak the directory rather than fail an unrelated
        // test from cleanup.
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

// Cleanup runs unconditionally after every test, including assertion failures,
// so no temporary repository or auxiliary file survives.
afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeDirBestEffort(dir);
  }
});

/**
 * Baseline fixture exercising every evidence category at once: a tracked
 * modification, a tracked deletion, and multiple untracked text additions
 * (one in a nested path containing spaces).
 */
async function buildFixture(dir: string): Promise<void> {
  await initRepo(dir);

  write(dir, "src/app.js", "console.log('v1');\n");
  write(dir, "gone.txt", "removed later\n");
  write(dir, "docs/base.txt", "base line\n");
  await commitAll(dir, "baseline");

  // Tracked modification.
  write(dir, "src/app.js", "console.log('v2');\n");
  // Tracked deletion.
  rmSync(join(dir, "gone.txt"));
  // Untracked additions, including a nested path containing spaces.
  write(dir, "notes/plain.txt", "hello note\n");
  write(dir, "notes/more.txt", "second note\n");
  write(dir, "my folder/sub dir/file with spaces.txt", "spaced path content\n");
}

describe("verify() review-evidence contract", () => {
  it("includes every tracked modification, tracked deletion, and untracked addition (including nested spaced paths) in diff and diffStat, and is stable across repeated calls", async () => {
    const dir = tempDir();
    await buildFixture(dir);

    const result = await verify(dir, []);

    // Every changed path appears in both outputs.
    for (const path of [
      "src/app.js",
      "gone.txt",
      "notes/plain.txt",
      "notes/more.txt",
      "my folder/sub dir/file with spaces.txt",
    ]) {
      expect(result.diff, `diff missing ${path}`).toContain(path);
      expect(result.diffStat, `diffStat missing ${path}`).toContain(path);
    }

    // Modification headers and new content.
    expect(result.diff).toContain("+++ b/src/app.js");
    expect(result.diff).toContain("-console.log('v1');");
    expect(result.diff).toContain("+console.log('v2');");

    // Deletion headers: old-side header plus /dev/null destination.
    expect(result.diff).toContain("deleted file mode 100644");
    expect(result.diff).toContain("--- a/gone.txt");
    expect(result.diff).toContain("+++ /dev/null");
    expect(result.diff).toContain("-removed later");

    // Untracked additions: new-file headers, /dev/null source, and new content.
    expect(result.diff).toContain("new file mode 100644");
    expect(result.diff).toContain("--- /dev/null");
    expect(result.diff).toContain("+++ b/notes/plain.txt");
    expect(result.diff).toContain("+hello note");
    expect(result.diff).toContain("+++ b/notes/more.txt");
    expect(result.diff).toContain("+second note");
    expect(result.diff).toContain("+++ b/my folder/sub dir/file with spaces.txt");
    expect(result.diff).toContain("+spaced path content");

    // Evidence-only work: with no configured commands, the sole check is the
    // pristine `git diff --check` and it passes.
    expect(result.passed).toBe(true);
    expect(result.checks.map((c) => c.command)).toEqual(["git diff --check"]);
    expect(result.checks[0].passed).toBe(true);
    expect(result.checks[0].exitCode).toBe(0);

    // Repeated verify calls over unchanged inputs return identical evidence.
    const second = await verify(dir, []);
    expect(second.diff).toBe(result.diff);
    expect(second.diffStat).toBe(result.diffStat);
    expect(second.gitStatus).toBe(result.gitStatus);
    expect(second.passed).toBe(result.passed);
  });

  it("includes staged changes alongside unstaged and untracked changes, proving the full HEAD-to-worktree delta", async () => {
    const dir = tempDir();
    await initRepo(dir);
    write(dir, "a.txt", "alpha\n");
    write(dir, "b.txt", "beta\n");
    await commitAll(dir, "baseline");

    // Stage b.txt with staged-only content, then extend the worktree file so
    // the HEAD-to-worktree delta contains lines that were never staged.
    write(dir, "b.txt", "beta staged\n");
    await g(dir, ["add", "b.txt"]);
    write(dir, "b.txt", "beta staged\nbeta worktree-only\n");
    // Unstaged tracked modification.
    write(dir, "a.txt", "alpha changed\n");
    // Untracked addition.
    write(dir, "c.txt", "c new\n");

    const result = await verify(dir, []);

    for (const path of ["a.txt", "b.txt", "c.txt"]) {
      expect(result.diff).toContain(path);
      expect(result.diffStat).toContain(path);
    }
    // The worktree state of the staged file is what is captured — the full
    // HEAD-to-worktree delta, not just what landed in the real index.
    expect(result.diff).toContain("+beta staged");
    expect(result.diff).toContain("+beta worktree-only");
    expect(result.diff).toContain("+alpha changed");
    expect(result.diff).toContain("+c new");
  });

  it("reports gitStatus identical to gitStatus(cwd, prefixes), keeps untracked files as ??, and leaves the real index, staged diff, and worktree unchanged", async () => {
    const dir = tempDir();
    await buildFixture(dir);

    // Add a genuinely staged change on top of the fixture.
    write(dir, "staged.txt", "staged content\n");
    await g(dir, ["add", "staged.txt"]);

    const realIndexPath = join(dir, ".git", "index");
    const indexBefore = readFileSync(realIndexPath);
    const stagedDiffBefore = (await g(dir, ["diff", "--cached"])).trim();
    const statusBefore = (await g(dir, ["status", "--short", "--untracked-files=all"])).trim();
    const headBefore = await g(dir, ["rev-parse", "HEAD"]);
    const worktreeBefore = readFileSync(join(dir, "src/app.js"));

    const result = await verify(dir, []);

    // Contract: verify's status equals the existing standalone gitStatus.
    expect(result.gitStatus).toBe(await gitStatus(dir));
    // Untracked files remain untracked (??) — verify never stages them.
    const untrackedLines = result.gitStatus
      .split("\n")
      .filter((line) => line.includes("file with spaces") || line.includes("notes/plain.txt") || line.includes("notes/more.txt"));
    expect(untrackedLines.length).toBe(3);
    for (const line of untrackedLines) {
      expect(line.startsWith("?? ")).toBe(true);
    }
    // The staged file is visible as A in the real status.
    expect(result.gitStatus).toContain("staged.txt");

    // The real index, staged diff, status, HEAD, and worktree are untouched.
    expect(readFileSync(realIndexPath)).toEqual(indexBefore);
    expect((await g(dir, ["diff", "--cached"])).trim()).toBe(stagedDiffBefore);
    expect((await g(dir, ["status", "--short", "--untracked-files=all"])).trim()).toBe(statusBefore);
    expect(await g(dir, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(readFileSync(join(dir, "src/app.js"))).toEqual(worktreeBefore);
  });

  it("honors explicit runtime-prefix exclusions and Git-ignored untracked files without false deletion evidence", async () => {
    const dir = tempDir();
    await initRepo(dir);
    write(dir, ".gitignore", "gen/\n");
    write(dir, "runtime/server.js", "server v1\n");
    write(dir, "runtime/other.js", "other v1\n");
    write(dir, "runtime-sibling.txt", "sibling v1\n");
    write(dir, "src/app.js", "app v1\n");
    await commitAll(dir, "baseline");

    // Untracked file honored by Git's own ignore rules.
    write(dir, "gen/build.txt", "build artifact\n");
    // Untracked file under the explicit ignored prefix.
    write(dir, "runtime/new.js", "fresh runtime file\n");
    // Tracked file under the explicit prefix: modified AND deleted.
    write(dir, "runtime/server.js", "server v2\n");
    rmSync(join(dir, "runtime/other.js"));
    // Tracked files outside the prefix boundary must still appear.
    write(dir, "runtime-sibling.txt", "sibling v2\n");
    write(dir, "src/app.js", "app v2\n");

    const result = await verify(dir, [], ["runtime"]);

    // Nothing beneath the literal prefix boundary produces evidence.
    expect(result.diff).not.toMatch(/b\/runtime\//);
    expect(result.diff).not.toContain("runtime/new.js");
    expect(result.diff).not.toContain("server v2");
    // No false deletion of the tracked, deleted file under the prefix.
    expect(result.diff).not.toMatch(/deleted file[^\n]*runtime\/other\.js/);
    // Git-ignored untracked content stays out of the evidence.
    expect(result.diff).not.toContain("gen/build.txt");
    expect(result.diffStat).not.toContain("gen/build.txt");
    expect(result.diffStat).not.toMatch(/runtime\//);

    // Sibling paths (not under the boundary) still appear with their changes.
    expect(result.diff).toContain("runtime-sibling.txt");
    expect(result.diff).toContain("+sibling v2");
    expect(result.diff).toContain("src/app.js");
    expect(result.diff).toContain("+app v2");
    expect(result.diffStat).toContain("runtime-sibling.txt");
    expect(result.diffStat).toContain("src/app.js");
  });

  it("runs configured commands in order after git diff --check, preserving output, exit codes, and passed aggregation", async () => {
    const dir = tempDir();
    await buildFixture(dir);

    const okCommand = 'node -e "console.log(\'verify-ok\')"';
    const failCommand = 'node -e "console.error(\'verify-boom\'); process.exit(3)"';

    const result = await verify(dir, [okCommand, failCommand]);

    // Ordering: built-in check first, then configured commands in order.
    expect(result.checks.map((c) => c.command)).toEqual(["git diff --check", okCommand, failCommand]);
    expect(result.checks[0].passed).toBe(true);
    expect(result.checks[0].exitCode).toBe(0);

    // Success command semantics.
    expect(result.checks[1].passed).toBe(true);
    expect(result.checks[1].exitCode).toBe(0);
    expect(result.checks[1].output).toContain("verify-ok");

    // Failure command semantics: non-zero exit code, captured output.
    expect(result.checks[2].passed).toBe(false);
    expect(result.checks[2].exitCode).toBe(3);
    expect(result.checks[2].output).toContain("verify-boom");

    // passed aggregates over checks only: one failure means overall failure.
    expect(result.passed).toBe(false);

    // All-pass aggregation.
    const allPass = await verify(dir, [okCommand]);
    expect(allPass.passed).toBe(true);
    expect(allPass.checks.every((c) => c.passed && c.exitCode === 0)).toBe(true);
  });

  it("keeps git diff --check semantics: untracked content does not affect it, tracked whitespace errors still do", async () => {
    const dir = tempDir();
    await initRepo(dir);
    write(dir, "ws.txt", "clean\n");
    await commitAll(dir, "baseline");

    // Untracked additions only: --check passes exactly as it would on the
    // tracked baseline, even though the evidence captures the untracked files.
    write(dir, "untracked-only.txt", "untracked\n");
    const untrackedOnly = await verify(dir, []);
    expect(untrackedOnly.checks[0].command).toBe("git diff --check");
    expect(untrackedOnly.checks[0].passed).toBe(true);
    expect(untrackedOnly.checks[0].exitCode).toBe(0);
    expect(untrackedOnly.diff).toContain("untracked-only.txt");

    // A tracked modification with trailing whitespace still fails --check,
    // proving the built-in check behavior is untouched by the new evidence path.
    write(dir, "ws.txt", "bad line with trailing space \n");
    const withWhitespaceError = await verify(dir, []);
    expect(withWhitespaceError.checks[0].command).toBe("git diff --check");
    expect(withWhitespaceError.checks[0].passed).toBe(false);
    expect(withWhitespaceError.checks[0].exitCode).not.toBe(0);
    expect(withWhitespaceError.checks[0].output).toContain("ws.txt");
    expect(withWhitespaceError.passed).toBe(false);
  });

  it("returns diagnostic evidence instead of throwing when verify() runs in a non-repository directory", async () => {
    const notRepo = tempDir();
    write(notRepo, "plain.txt", "no git here\n");

    // Must resolve — never throw — and must not claim success.
    const result = await verify(notRepo, []);

    expect(result.diff).toContain("git evidence capture failed");
    expect(result.diffStat).toContain("git evidence capture failed");
    // passed derives from checks only, and `git diff --check` cannot pass here.
    expect(result.checks[0].command).toBe("git diff --check");
    expect(result.checks[0].passed).toBe(false);
    expect(result.passed).toBe(false);
    // No partial or synthesized patch: the diagnostic replaced both outputs.
    expect(result.diff).not.toContain("+++ b/");
  });

  it("includes force-added ignored staged files in verify() evidence", async () => {
    const dir = tempDir();
    await initRepo(dir);
    write(dir, ".gitignore", "secret/\n");
    write(dir, "base.txt", "base\n");
    await commitAll(dir, "baseline");

    // Staged into the real index despite .gitignore, then modified again in
    // the worktree; the evidence must show the current worktree content.
    write(dir, "secret/plan.txt", "staged but ignored\n");
    await g(dir, ["add", "-f", "secret/plan.txt"]);
    write(dir, "secret/plan.txt", "staged but ignored (worktree)\n");
    // Ordinary ignored untracked content stays out of the evidence.
    write(dir, "secret/other.txt", "not staged\n");
    // A normal untracked addition.
    write(dir, "normal.txt", "ordinary\n");

    const result = await verify(dir, []);

    for (const path of ["secret/plan.txt", "normal.txt"]) {
      expect(result.diff, `diff missing ${path}`).toContain(path);
      expect(result.diffStat, `diffStat missing ${path}`).toContain(path);
    }
    expect(result.diff).toContain("+staged but ignored (worktree)");
    expect(result.diff).not.toContain("secret/other.txt");
    expect(result.diffStat).not.toContain("secret/other.txt");
    // Status reporting is unchanged and matches the standalone helper.
    expect(result.gitStatus).toBe(await gitStatus(dir));
    expect(result.passed).toBe(true);
  });

  it("reports diagnostic evidence while checks still pass when evidence capture itself fails", async () => {
    const dir = tempDir();
    await initRepo(dir);
    write(dir, "a.txt", "a\n");
    await commitAll(dir, "baseline");

    // Break the branch ref so HEAD no longer resolves to a commit, but keep
    // the index and worktree in agreement so `git diff --check` still passes.
    // This isolates an evidence-only failure: checks pass, capture cannot.
    // `git update-ref` is deliberately avoided: this Git version validates
    // object existence, so the loose ref file is corrupted directly.
    writeFileSync(
      join(dir, ".git", "refs", "heads", "main"),
      "0123456789abcdef0123456789abcdef01234567\n",
      "utf8",
    );

    const result = await verify(dir, []);

    expect(result.checks[0].command).toBe("git diff --check");
    expect(result.checks[0].passed).toBe(true);
    expect(result.checks[0].exitCode).toBe(0);
    // passed is derived from checks only; the evidence failure must not
    // change it, nor throw, nor fall back to incomplete evidence.
    expect(result.passed).toBe(true);
    expect(result.diff).toContain("git evidence capture failed");
    expect(result.diffStat).toContain("git evidence capture failed");
    expect(result.diff).not.toContain("+++ b/");
  });

  it("captures untracked additions in a valid unborn repository (no initial commit)", async () => {
    const dir = tempDir();
    await initRepo(dir);
    // No commit: HEAD is unborn.
    write(dir, "brand/new.txt", "fresh\n");
    write(dir, "brand/spaced dir/second file.txt", "second fresh\n");

    const result = await verify(dir, []);

    expect(result.diff).toContain("new file mode 100644");
    expect(result.diff).toContain("+++ b/brand/new.txt");
    expect(result.diff).toContain("+fresh");
    expect(result.diff).toContain("+++ b/brand/spaced dir/second file.txt");
    expect(result.diff).toContain("+second fresh");
    expect(result.diffStat).toContain("brand/new.txt");
    expect(result.diffStat).toContain("brand/spaced dir/second file.txt");
    // --check is clean on an unborn repository with only untracked files.
    expect(result.checks[0].passed).toBe(true);
    expect(result.checks[0].exitCode).toBe(0);
  });
});
