import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { captureGitEvidence } from "../src/git-evidence.js";

const execFileP = promisify(execFile);

async function g(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

async function initRepo(dir: string, branch = "main"): Promise<void> {
  await g(dir, ["init", "-b", branch]);
  await g(dir, ["config", "user.name", "Evidence Test"]);
  await g(dir, ["config", "user.email", "evidence@test.local"]);
  await g(dir, ["config", "commit.gpgsign", "false"]);
}

function write(dir: string, rel: string, data: string | Buffer): string {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
  return abs;
}

async function commitAll(dir: string, message: string): Promise<void> {
  await g(dir, ["add", "-A"]);
  await g(dir, ["commit", "-m", message]);
}

const tempDirs: string[] = [];
function tempDir(prefix = "pi-sf-gev-test-"): string {
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

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeDirBestEffort(dir);
  }
});

describe("captureGitEvidence", () => {
  it("returns empty evidence for a clean repository and is stable across repeated captures", async () => {
    const dir = tempDir();
    await initRepo(dir);
    write(dir, "readme.txt", "hello\n");
    await commitAll(dir, "baseline");

    const first = await captureGitEvidence(dir);
    const second = await captureGitEvidence(dir);

    expect(first.diff).toBe("");
    expect(first.diffStat).toBe("");
    expect(second).toEqual(first);
  });

  it("supports a valid unborn repository (no HEAD) using an empty baseline", async () => {
    const dir = tempDir();
    await initRepo(dir);
    // No commit yet — HEAD is unborn.
    write(dir, "brand/new.txt", "fresh\n");

    const { diff, diffStat } = await captureGitEvidence(dir);

    expect(diff).toContain("b/brand/new.txt");
    expect(diff).toContain("+fresh");
    expect(diffStat).toContain("brand/new.txt");
  });

  it("supports an unborn branch when a nested ref shares its prefix", async () => {
    const dir = tempDir();

    // Create a real baseline commit on the repository's normal branch.
    await initRepo(dir);
    write(dir, "seed.txt", "seed\n");
    await commitAll(dir, "seed");

    // refs/heads/topic itself does not exist, but a nested ref sharing
    // that prefix does. Prefix-based ref lookup must not mistake topic/foo
    // for the exact topic ref.
    await g(dir, ["branch", "topic/foo"]);

    // Point HEAD at the absent exact ref: topic is now a valid unborn branch.
    await g(dir, ["symbolic-ref", "HEAD", "refs/heads/topic"]);

    write(dir, "brand/new.txt", "fresh\n");

    const { diff, diffStat } = await captureGitEvidence(dir);

    expect(diff).toContain("b/brand/new.txt");
    expect(diff).toContain("+fresh");
    expect(diffStat).toContain("brand/new.txt");
  });
  it("excludes ignored untracked paths, modified/deleted tracked paths under a prefix, and keeps sibling paths", async () => {
    const dir = tempDir();
    await initRepo(dir);

    // Tracked baseline files.
    write(dir, "runtime/server.js", "console.log('v1');\n");
    write(dir, "runtime/other.js", "export const other = 1;\n");
    write(dir, "runtimeserver.js", "console.log('v1');\n");
    write(dir, "node modules cache/x.js", "module.exports = 1;\n");
    write(dir, "data/cache/blob.bin", "seed-data");
    write(dir, "data/cachedblob.bin", "seed-data");
    await commitAll(dir, "baseline");

    // Tracked file under the ignored prefix is modified and one is deleted.
    write(dir, "runtime/server.js", "console.log('v2');\n");
    rmSync(join(dir, "runtime/other.js"));
    // Tracked sibling (NOT under the prefix) is modified.
    write(dir, "runtimeserver.js", "console.log('v2');\n");
    // Tracked space-prefixed file modified; its sibling modified too.
    write(dir, "node modules cache/x.js", "module.exports = 2;\n");
    write(dir, "data/cachedblob.bin", "changed-data");
    // Tracked backslash-normalized prefix file modified.
    write(dir, "data/cache/blob.bin", "changed-data");
    // Untracked files under the ignored prefixes (should be invisible).
    write(dir, "runtime/newfile.js", "fresh\n");
    write(dir, "node modules cache/new.txt", "fresh\n");

    const { diff, diffStat } = await captureGitEvidence(dir, [
      "runtime",
      "node modules cache",
      "data\\cache",
    ]);

    // No evidence from anything beneath the ignored prefixes.
    expect(diff).not.toContain("runtime/server.js");
    expect(diff).not.toContain("runtime/other.js");
    expect(diff).not.toContain("runtime/newfile.js");
    expect(diff).not.toContain("node modules cache/x.js");
    expect(diff).not.toContain("node modules cache/new.txt");
    expect(diff).not.toContain("data/cache/blob.bin");
    // No false deletion of the tracked, deleted file under the ignored prefix.
    expect(diff).not.toMatch(/^deleted file.*runtime\/other\.js/m);

    // Sibling paths (not under a prefix boundary) still produce evidence.
    expect(diff).toContain("runtimeserver.js");
    expect(diff).toContain("+console.log('v2');");
    expect(diff).toContain("data/cachedblob.bin");
    expect(diffStat).toContain("runtimeserver.js");
    expect(diffStat).toContain("data/cachedblob.bin");
    expect(diffStat).not.toContain("runtime/server.js");
  });

  it("captures binary additions/changes losslessly and the patch re-applies byte-for-byte to a clean baseline", async () => {
    const dir = tempDir();
    await initRepo(dir);

    const originalImg = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03, 0xff, 0x00]);
    write(dir, "img.bin", originalImg);
    write(dir, "delete-me.txt", "to be removed\n");
    await commitAll(dir, "baseline");

    const modifiedImg = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xaa, 0xbb, 0xcc, 0xdd, 0x00, 0x42, 0x13, 0x37]);
    write(dir, "img.bin", modifiedImg);
    const newBin = Buffer.from([0x00, 0x01, 0x02, 0x00, 0xde, 0xad, 0xbe, 0xef]);
    write(dir, "add.bin", newBin);
    rmSync(join(dir, "delete-me.txt"));

    const { diff } = await captureGitEvidence(dir);

    // Binary patches are emitted verbatim (not summarized).
    expect(diff).toContain("GIT binary patch");
    expect(diff).toContain("b/img.bin");
    expect(diff).toContain("b/add.bin");

    // Write the returned patch unchanged to disk.
    const patchPath = write(tempDir("pi-sf-gev-patch-"), "evidence.patch", diff);

    // Apply it to a clean baseline worktree at HEAD.
    const wt = tempDir("pi-sf-gev-wt-");
    await g(dir, ["worktree", "add", "--detach", wt, "HEAD"]);
    try {
      await g(wt, ["apply", "--check", patchPath]);
      await g(wt, ["apply", patchPath]);

      expect(readFileSync(join(wt, "img.bin"))).toEqual(modifiedImg);
      expect(readFileSync(join(wt, "add.bin"))).toEqual(newBin);
      expect(existsSync(join(wt, "delete-me.txt"))).toBe(false);
    } finally {
      await g(dir, ["worktree", "remove", "--force", wt]).catch(() => {});
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("does not mutate the real index, refs, status, or worktree contents", async () => {
    const dir = tempDir();
    await initRepo(dir);
    write(dir, "stable.txt", "stable\n");
    write(dir, "gone.txt", "gone\n");
    await commitAll(dir, "baseline");

    // Introduce worktree changes: modified tracked, untracked, deleted tracked.
    write(dir, "stable.txt", "modified\n");
    write(dir, "untracked.txt", "new\n");
    rmSync(join(dir, "gone.txt"));

    const realIndexPath = join(dir, ".git", "index");
    const indexBefore = readFileSync(realIndexPath);
    const statusBefore = (await g(dir, ["status", "--short", "--untracked-files=all"])).trim();
    const headBefore = await g(dir, ["rev-parse", "HEAD"]);
    const commitCountBefore = (await g(dir, ["rev-list", "--count", "HEAD"])).trim();
    const worktreeBefore = readFileSync(join(dir, "stable.txt"));

    const evidence = await captureGitEvidence(dir);

    // It did actually capture the changes.
    expect(evidence.diff).toContain("stable.txt");
    expect(evidence.diff).toContain("untracked.txt");
    expect(evidence.diff).toContain("gone.txt");

    // Real index bytes are byte-for-byte unchanged.
    expect(readFileSync(realIndexPath)).toEqual(indexBefore);
    // Status, refs, and worktree contents are unchanged.
    expect((await g(dir, ["status", "--short", "--untracked-files=all"])).trim()).toBe(statusBefore);
    expect(await g(dir, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect((await g(dir, ["rev-list", "--count", "HEAD"])).trim()).toBe(commitCountBefore);
    expect(readFileSync(join(dir, "stable.txt"))).toEqual(worktreeBefore);
  });

  it("treats ignored prefixes as literal path boundaries, not Git glob patterns", async () => {
    const dir = tempDir();
    await initRepo(dir);
    write(dir, "runtime[1]/a.txt", "bracket v1\n");
    write(dir, "runtime1/b.txt", "sibling v1\n");
    await commitAll(dir, "baseline");

    write(dir, "runtime[1]/a.txt", "bracket v2\n");
    write(dir, "runtime1/b.txt", "sibling v2\n");

    const { diff, diffStat } = await captureGitEvidence(dir, ["runtime[1]"]);

    // The metacharacter prefix matches only its own literal path.
    expect(diff).not.toContain("runtime[1]/a.txt");
    expect(diffStat).not.toContain("runtime[1]/a.txt");
    // The similarly named sibling is included in BOTH outputs (a glob-
    // interpreted `runtime[1]` would invert exactly this).
    expect(diff).toContain("runtime1/b.txt");
    expect(diff).toContain("+sibling v2");
    expect(diffStat).toContain("runtime1/b.txt");
  });

  it("applies exclusions during capture so problematic excluded content cannot break it", async () => {
    const dir = tempDir();
    await initRepo(dir);
    write(dir, "src/app.js", "v1\n");
    await commitAll(dir, "baseline");

    // Genuine implementation evidence outside the excluded prefix.
    write(dir, "src/app.js", "v2\n");
    // An embedded (unborn) repository beneath the excluded prefix. Without
    // capture-time exclusions `git add -A` would refuse the whole capture with
    // "adding embedded git repository".
    const nested = join(dir, "runtime", "nested");
    mkdirSync(nested, { recursive: true });
    await g(nested, ["init"]);
    write(dir, "runtime/ignored.txt", "hidden content\n");

    const { diff, diffStat } = await captureGitEvidence(dir, ["runtime"]);

    expect(diff).toContain("src/app.js");
    expect(diff).toContain("+v2");
    expect(diff).not.toContain("runtime/");
    expect(diff).not.toContain("hidden content");
    expect(diffStat).toContain("src/app.js");
    expect(diffStat).not.toContain("runtime/");
  });

  it("includes real-index-tracked ignored files (git add -f) while keeping ordinary ignored files out", async () => {
    const dir = tempDir();
    await initRepo(dir);
    write(dir, ".gitignore", "secret/\n");
    write(dir, "base.txt", "base\n");
    await commitAll(dir, "baseline");

    // Staged into the REAL index despite .gitignore, then modified again in
    // the worktree so the snapshot must reflect current worktree contents.
    write(dir, "secret/plan.txt", "staged but ignored\n");
    await g(dir, ["add", "-f", "secret/plan.txt"]);
    write(dir, "secret/plan.txt", "staged but ignored (worktree)\n");
    // A normal untracked, non-ignored addition.
    write(dir, "normal.txt", "ordinary\n");

    const { diff, diffStat } = await captureGitEvidence(dir);

    expect(diff).toContain("secret/plan.txt");
    expect(diff).toContain("+staged but ignored (worktree)");
    expect(diff).toContain("normal.txt");
    expect(diff).toContain("+ordinary");
    expect(diffStat).toContain("secret/plan.txt");
    expect(diffStat).toContain("normal.txt");

    // An ordinary ignored untracked file (never staged) stays excluded.
    write(dir, "secret/other.txt", "not staged\n");
    const second = await captureGitEvidence(dir);
    expect(second.diff).not.toContain("secret/other.txt");
    expect(second.diffStat).not.toContain("secret/other.txt");
  });

  it("rejects on a broken HEAD instead of silently falling back to the empty baseline", async () => {
    const dir = tempDir();
    await initRepo(dir);
    write(dir, "a.txt", "a\n");
    await commitAll(dir, "baseline");

    // Point the branch ref at a commit object that does not exist. HEAD now
    // resolves to a ref, but not to a commit. This is NOT an unborn branch.
    // `git update-ref` is deliberately avoided: this Git version validates
    // object existence, so the loose ref file is corrupted directly.
    writeFileSync(
      join(dir, ".git", "refs", "heads", "main"),
      "0123456789abcdef0123456789abcdef01234567\n",
      "utf8",
    );

    await expect(captureGitEvidence(dir)).rejects.toThrow(/baseline/);
  });

  it("rejects on a stdout buffer overflow instead of returning truncated patch evidence", async () => {
    const dir = tempDir();
    await initRepo(dir);
    // 20 MiB of cryptographically random bytes: incompressible, so the binary
    // patch exceeds the 16 MiB bounded buffer and capture must fail explicitly
    // rather than truncate.
    const big = randomBytes(20 * 1024 * 1024);
    write(dir, "big.bin", big);

    await expect(captureGitEvidence(dir)).rejects.toThrow();
  });

  it("rejects on a Git failure and cleans up this invocation's scratch resources without partial evidence", async () => {
    // The scratch base is specific to this invocation, so the assertion is
    // unaffected by concurrently running captures in other test workers.
    const scratchBase = tempDir("pi-sf-gev-scratch-");
    const notRepo = tempDir();

    await expect(
      captureGitEvidence(notRepo, [], { scratchBaseDir: scratchBase }),
    ).rejects.toThrow();

    expect(readdirSync(scratchBase)).toEqual([]);
  });
});
