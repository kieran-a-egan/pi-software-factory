/**
 * Focused process-boundary coverage for the exported process seam of
 * benchmarks/autonomy/run-batch-cli.ts, exercised directly without invoking
 * runBatch, Pi, Factory, models, Git, assertion scripts, or scoring:
 *
 * - `buildPiProcessRequest` returns the shell-free launch representation:
 *   `process.execPath` with exactly `[installed Pi JavaScript entry,
 *   '--approve', '--no-session', '-p']`, the candidate root exactly as
 *   passed as cwd, and the exact `/factory <objective>` text on stdin — no
 *   trimming, escaping, or appended content, proven with an objective
 *   containing leading/trailing whitespace, quotes, shell metacharacters,
 *   and a newline; the installed entry is resolved independently from the
 *   Pi package's bin metadata and verified to exist without ever executing
 *   it;
 * - `buildAssertionProcessRequest` returns `process.execPath` with exactly
 *   `['--import', installed tsx loader file URL, resolve(assertionPath),
 *   resolve(candidateRoot)]`, the original candidate root as cwd, and no
 *   stdin; the assertion and candidate paths are supplied as relative,
 *   unnormalized strings containing spaces, so both resolve() operations
 *   are observable (asserted against independently computed absolute
 *   paths, with the original relative candidate root retained as cwd), and
 *   neither the assertion file nor its candidate is created or executed;
 * - `createProductionProcessRunner` writes the exact stdin text (leading/
 *   trailing whitespace, newline, and Unicode preserved; no automatic final
 *   newline) to a small inline Node child that produces output only after
 *   stdin ends — proving stdin is closed — under a bounded child-side
 *   watchdog that exits nonzero if EOF never arrives, and drains exact
 *   stdout/stderr with exitCode 0, signal null, and no launchError;
 * - a nonzero child exit (set via `process.exitCode` so output drains
 *   naturally) resolves as evidence with the exact code, captured output,
 *   signal null, and no launchError — the promise never rejects;
 * - a guaranteed nonexistent absolute executable beneath an existing temp
 *   root resolves as evidence with a nonempty launchError and empty
 *   stdout/stderr, without asserting a platform-specific exit code or
 *   message.
 *
 * Only small local Node subprocesses are spawned; installed Pi and tsx
 * entries are resolved through package metadata and module resolution only.
 * Temp roots are cleaned up after each test.
 */
import { afterEach, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildAssertionProcessRequest,
  buildPiProcessRequest,
  createProductionProcessRunner,
} from "../benchmarks/autonomy/run-batch-cli.js";

/** Repo root derived from this test file's location. */
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Modest explicit subprocess allowance: Node child startup is fast on both
 * CI platforms, but Windows startup/contention can exceed Vitest's 5s
 * default; the value mirrors the in-repo integration timeout precedent.
 */
const SUBPROCESS_TIMEOUT_MS = process.platform === "win32" ? 15_000 : 5_000;

/**
 * Bounded child-side watchdog for the EOF-driven success child: if the
 * runner leaves stdin open, the child destroys its stdin pipe (emptying the
 * event loop) and exits nonzero this long after startup instead of
 * hanging. It stays comfortably below
 * SUBPROCESS_TIMEOUT_MS on both platforms so the regression fails on the
 * exact-output assertions and terminates the child itself, leaving no
 * orphaned process behind.
 */
const STDIN_WATCHDOG_MS = process.platform === "win32" ? 5_000 : 2_000;

const require = createRequire(import.meta.url);

/** Temp roots created by this suite, removed reliably in `afterEach`. */
const tempRoots: string[] = [];

/** Create and track a fresh disposable temp root. */
async function tempRoot(prefix = "batch-process-test-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

/**
 * Remove one tracked temp root with bounded retries: a just-exited child can
 * briefly hold handles on Windows. Exhausted retries surface the failure
 * rather than leaking the directory.
 */
async function removeRoot(root: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 9) {
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 100));
      }
    }
  }
  throw lastError;
}

afterEach(async () => {
  const roots = tempRoots.splice(0);
  for (const root of roots) {
    await removeRoot(root);
  }
});

/**
 * Independently resolve the installed Pi package's `pi` bin as an absolute
 * JavaScript entry from its package.json bin metadata (no execution, no
 * reuse of the module under test's resolution helpers).
 */
async function installedPiEntryPath(): Promise<string> {
  const packageJsonPath = join(
    repoRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "package.json",
  );
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const bin = packageJson.bin;
  const relativeBinPath = typeof bin === "string" ? bin : bin === undefined ? undefined : bin["pi"];
  if (typeof relativeBinPath !== "string" || relativeBinPath.length === 0) {
    throw new Error(`installed Pi package.json has no "pi" bin entry at ${packageJsonPath}`);
  }
  return resolve(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", relativeBinPath);
}

it("buildPiProcessRequest builds the shell-free Pi launch with the exact objective on stdin", async () => {
  const candidateRoot = await tempRoot("batch-process-pi-candidate-");
  // Leading/trailing whitespace, quotes, shell metacharacters, and a
  // newline: any trimming, escaping, or appended content in the stdin
  // template fails the exact match.
  const objective =
    '  Refactor the "fixture" module (v2) and handle `edge cases` & <tags>;\nkeep the public API unchanged  ';

  const request = buildPiProcessRequest(candidateRoot, objective);

  const piEntryPath = await installedPiEntryPath();
  expect(existsSync(piEntryPath)).toBe(true);

  expect(request).toEqual({
    executable: process.execPath,
    args: [piEntryPath, "--approve", "--no-session", "-p"],
    cwd: candidateRoot,
    stdin: `/factory ${objective}`,
  });
});

it("buildAssertionProcessRequest builds the shell-free assertion launch with resolved absolute paths and no stdin", () => {
  // Relative, unnormalized paths with spaces: `join` keeps the leading
  // `..`, so neither input is absolute and both builder resolve() calls do
  // real work. If either resolve were dropped, the expected absolute
  // arguments below would mismatch. Neither the assertion file nor its
  // candidate root is created or executed.
  const candidateRoot = join("..", "batch-process candidate root");
  const assertionPath = join("..", "batch-process case dir", "assert.ts");
  const expectedAssertionPath = resolve(assertionPath);
  const expectedCandidateRoot = resolve(candidateRoot);
  // Sanity: the fixtures are relative, so resolve is not an identity here.
  expect(isAbsolute(assertionPath)).toBe(false);
  expect(isAbsolute(candidateRoot)).toBe(false);

  const request = buildAssertionProcessRequest(assertionPath, candidateRoot);

  // Resolve the installed tsx loader independently via module resolution and
  // file URL conversion (no execution, no reuse of the module under test's
  // resolution helpers).
  const tsxLoaderUrl = pathToFileURL(require.resolve("tsx")).href;
  expect(existsSync(fileURLToPath(tsxLoaderUrl))).toBe(true);

  expect(request).toEqual({
    executable: process.execPath,
    args: ["--import", tsxLoaderUrl, expectedAssertionPath, expectedCandidateRoot],
    // The original relative candidate root is retained as cwd (unresolved).
    cwd: candidateRoot,
  });
  expect(request.stdin).toBeUndefined();
});

it("createProductionProcessRunner writes exact stdin, closes it, and captures stdout/stderr of a successful child", async () => {
  const cwd = await tempRoot("batch-process-runner-success-");
  const runner = createProductionProcessRunner();
  // Leading/trailing whitespace, newline, and Unicode, with no trailing
  // newline: an automatic final newline or any trimming would fail the
  // exact stdout match.
  const stdinText = "  line one\nsecond line with unicode: café ✓  ";

  // The child emits nothing until stdin 'end' fires; the bounded watchdog
  // destroys stdin and sets exit code 7 if EOF never arrives, so a runner
  // that leaves stdin open fails the exact-output assertions below and the
  // child terminates itself (the destroyed stdin pipe no longer keeps the
  // event loop alive) instead of hanging.
  const result = await runner({
    executable: process.execPath,
    args: [
      "-e",
      [
        "const chunks = [];",
        `const watchdog = setTimeout(() => {`,
        '  process.stderr.write("stderr-marker:watchdog\\n");',
        "  process.stdin.destroy();",
        "  process.exitCode = 7;",
        `}, ${STDIN_WATCHDOG_MS});`,
        'process.stdin.on("data", (chunk) => chunks.push(chunk));',
        'process.stdin.on("end", () => {',
        "  clearTimeout(watchdog);",
        '  process.stdout.write(Buffer.concat(chunks).toString("utf8"));',
        '  process.stderr.write("stderr-marker:done\\n");',
        "});",
      ].join("\n"),
    ],
    cwd,
    stdin: stdinText,
  });

  expect(result.exitCode).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.launchError).toBeUndefined();
  expect(result.stdout).toBe(stdinText);
  expect(result.stderr).toBe("stderr-marker:done\n");
}, SUBPROCESS_TIMEOUT_MS);

it("createProductionProcessRunner resolves a nonzero child exit as evidence without rejecting", async () => {
  const cwd = await tempRoot("batch-process-runner-nonzero-");
  const runner = createProductionProcessRunner();

  // `process.exitCode` (not `process.exit`) lets both streams drain
  // naturally before the child terminates with the chosen nonzero code.
  const result = await runner({
    executable: process.execPath,
    args: [
      "-e",
      'process.stdout.write("stdout-before-exit\\n");' +
        'process.stderr.write("stderr-before-exit\\n");' +
        "process.exitCode = 3;",
    ],
    cwd,
  });

  expect(result.exitCode).toBe(3);
  expect(result.signal).toBeNull();
  expect(result.launchError).toBeUndefined();
  expect(result.stdout).toBe("stdout-before-exit\n");
  expect(result.stderr).toBe("stderr-before-exit\n");
}, SUBPROCESS_TIMEOUT_MS);

it("createProductionProcessRunner resolves a failed launch as evidence with a nonempty launchError and empty streams", async () => {
  const root = await tempRoot("batch-process-runner-launch-failure-");
  // Guaranteed nonexistent absolute executable beneath an existing temp
  // root; no stdin is supplied.
  const missingExecutable = join(root, "definitely-missing", "no-such-executable");
  const runner = createProductionProcessRunner();

  const result = await runner({
    executable: missingExecutable,
    args: [],
    cwd: root,
  });

  // launchError is the authoritative launch-failure signal; its message and
  // the exitCode are platform-specific (null on POSIX, a libuv code such as
  // -4058 on Windows), so only its presence is asserted.
  expect(typeof result.launchError === "string" && result.launchError.length > 0).toBe(true);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
  expect(result.signal).toBeNull();
}, SUBPROCESS_TIMEOUT_MS);
