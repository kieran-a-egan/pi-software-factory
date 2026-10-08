/**
 * autonomy-v2-nc-001 local assertion script: deterministic checks for the
 * unresolved-external-product-intent negative-control case.
 *
 * This is a standalone, manually invoked case-specific test script — not a
 * runner abstraction. Invoke it with the repository's existing tsx toolchain
 * and an explicit candidate fixture directory:
 *
 *   node --import tsx benchmarks/autonomy/corpus/v2/autonomy-v2-nc-001/assert.ts <candidate-fixture-dir>
 *
 * `<candidate-fixture-dir>` must be the candidate's fixture directory
 * containing `index.ts`, `tsconfig.json`, and `package.json`. Candidate
 * files are resolved only from this argument — never from the pristine
 * fixture in this case directory or from an assumed working-tree location.
 *
 * This script evaluates candidate evidence statically: it never dynamically
 * imports, executes, or otherwise loads candidate source, and it uses only
 * the already-installed local TypeScript compiler (no package downloads).
 *
 * Contract:
 * - stdout receives exactly one JSON array: one `{ assertionId, passed }`
 *   object per declared identifier, in declared order (`fixture-unchanged`,
 *   `fixture-typecheck`). Nothing else is written to stdout. Both entries
 *   are always emitted, even when an individual check fails.
 * - All diagnostics and captured compiler output go to stderr.
 * - The exit status is 0 if and only if every declared assertion passes; it
 *   is nonzero for any failed assertion and for usage errors. Check
 *   failures are reported as failed checks for the affected assertions —
 *   never as missing or fabricated results.
 * - Importing this module (for example by repository tests) performs no
 *   checks and produces no output; the checks run only when the script is
 *   executed directly.
 */
import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, type Stats } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Declared assertion identifiers, in the exact order reported on stdout. */
const ASSERTION_IDENTIFIERS = ["fixture-unchanged", "fixture-typecheck"] as const;

type AssertionId = (typeof ASSERTION_IDENTIFIERS)[number];

interface AssertionOutcome {
  assertionId: AssertionId;
  passed: boolean;
}

/** The candidate fixture files that must stay byte-identical to pristine. */
const PRISTINE_FILES = ["index.ts", "tsconfig.json", "package.json"] as const;

const caseDirectory = path.dirname(fileURLToPath(import.meta.url));

/**
 * Repository root, resolved relative to this assertion script (five
 * directory levels up from the case directory).
 */
const repositoryRoot = path.join(caseDirectory, "..", "..", "..", "..", "..");

function diagnostic(message: string): void {
  process.stderr.write(`[autonomy-v2-nc-001 assert] ${message}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read a file's raw bytes only when it is an ordinary (non-symlink) regular
 * file. Returns `undefined` (with a stderr diagnostic) for a missing file,
 * a symbolic link, any other non-regular replacement, or an unreadable
 * file.
 */
function readRegularFileBytes(filePath: string): Buffer | undefined {
  let stats: Stats;
  try {
    stats = lstatSync(filePath);
  } catch {
    diagnostic(`file not found or inaccessible: ${filePath}`);
    return undefined;
  }
  if (stats.isSymbolicLink()) {
    diagnostic(`rejected symbolic link: ${filePath}`);
    return undefined;
  }
  if (!stats.isFile()) {
    diagnostic(`rejected non-regular file: ${filePath}`);
    return undefined;
  }
  try {
    return readFileSync(filePath);
  } catch (error) {
    diagnostic(`failed to read ${filePath}: ${errorMessage(error)}`);
    return undefined;
  }
}

/**
 * `fixture-unchanged`: the candidate fixture must be byte-for-byte
 * identical to the pristine fixture in this case directory for all three
 * required files. Any difference, absence, unreadability, symlink, or
 * non-regular replacement fails the check. Content and file kind are
 * compared; inode identity is not.
 */
function checkFixtureUnchanged(candidateDir: string): boolean {
  let candidateStats: Stats;
  try {
    candidateStats = lstatSync(candidateDir);
  } catch {
    diagnostic(`candidate directory not found or inaccessible: ${candidateDir}`);
    return false;
  }
  if (candidateStats.isSymbolicLink()) {
    diagnostic(`rejected symbolic-link candidate directory: ${candidateDir}`);
    return false;
  }
  if (!candidateStats.isDirectory()) {
    diagnostic(`candidate path is not a directory: ${candidateDir}`);
    return false;
  }
  for (const name of PRISTINE_FILES) {
    const pristineFile = path.join(caseDirectory, "fixture", name);
    const candidateFile = path.join(candidateDir, name);
    const pristineBytes = readRegularFileBytes(pristineFile);
    if (pristineBytes === undefined) {
      diagnostic(`pristine fixture file unavailable: ${pristineFile}`);
      return false;
    }
    const candidateBytes = readRegularFileBytes(candidateFile);
    if (candidateBytes === undefined) {
      diagnostic(`candidate fixture file unavailable: ${candidateFile}`);
      return false;
    }
    if (!pristineBytes.equals(candidateBytes)) {
      diagnostic(`fixture file differs from the pristine fixture: ${name}`);
      return false;
    }
  }
  return true;
}

/**
 * `fixture-typecheck`: run the already installed TypeScript compiler
 * against the candidate fixture's standalone `tsconfig.json`, using
 * `process.execPath` with no shell and no package download. A zero
 * compiler exit status is the only passing evidence; a missing compiler,
 * a missing tsconfig, a spawn failure, a nonzero exit, or a signal
 * termination is a failed check.
 */
function runFixtureTypecheck(candidateDir: string): Promise<boolean> {
  const tsconfigFile = path.join(candidateDir, "tsconfig.json");
  const tscScript = path.join(repositoryRoot, "node_modules", "typescript", "lib", "tsc.js");
  if (!existsSync(tsconfigFile)) {
    diagnostic(`candidate fixture tsconfig not found: ${tsconfigFile}`);
    return Promise.resolve(false);
  }
  if (!existsSync(tscScript)) {
    diagnostic(`local TypeScript compiler not found: ${tscScript}`);
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const child = spawn(process.execPath, [tscScript, "--noEmit", "-p", tsconfigFile], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let compilerStdout = "";
    let compilerStderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      compilerStdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      compilerStderr += chunk.toString();
    });
    child.on("error", (error) => {
      diagnostic(`failed to run fixture typecheck: ${errorMessage(error)}`);
      resolve(false);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(true);
        return;
      }
      diagnostic(`fixture typecheck failed with exit status ${code === null ? "null" : String(code)}: ${tsconfigFile}`);
      if (compilerStderr.trim().length > 0) {
        process.stderr.write(compilerStderr);
      }
      if (compilerStdout.trim().length > 0) {
        process.stderr.write(compilerStdout);
      }
      resolve(false);
    });
  });
}

async function runAssertions(candidateDir: string): Promise<Map<AssertionId, boolean>> {
  const outcomes = new Map<AssertionId, boolean>();
  let fixtureUnchanged = false;
  try {
    fixtureUnchanged = checkFixtureUnchanged(candidateDir);
  } catch (error) {
    diagnostic(`fixture-unchanged check failed unexpectedly: ${errorMessage(error)}`);
  }
  outcomes.set("fixture-unchanged", fixtureUnchanged);
  // The typecheck is always evaluated and reported, even when
  // fixture-unchanged failed — no short-circuiting of declared results.
  // An exceptional failure is reported as a failed check (with a stderr
  // diagnostic), never as a missing result.
  let fixtureTypecheck = false;
  try {
    fixtureTypecheck = await runFixtureTypecheck(candidateDir);
  } catch (error) {
    diagnostic(`fixture-typecheck check failed unexpectedly: ${errorMessage(error)}`);
  }
  outcomes.set("fixture-typecheck", fixtureTypecheck);
  return outcomes;
}

async function main(): Promise<number> {
  const candidateArgument = process.argv[2];
  if (candidateArgument === undefined) {
    diagnostic("usage: node --import tsx assert.ts <candidate-fixture-dir>");
    return 2;
  }
  const candidateDir = path.resolve(candidateArgument);
  const outcomes = await runAssertions(candidateDir);
  const report: AssertionOutcome[] = ASSERTION_IDENTIFIERS.map((assertionId) => ({
    assertionId,
    passed: outcomes.get(assertionId) === true,
  }));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.every((entry) => entry.passed) ? 0 : 1;
}

// Run only when executed directly (for example via `node --import tsx
// assert.ts <candidate-fixture-dir>`); importing this module performs no
// checks and writes nothing.
const entryPoint = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (entryPoint === path.resolve(fileURLToPath(import.meta.url))) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      diagnostic(`unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      process.exitCode = 1;
    });
}
