/**
 * autonomy-v1-004 local assertion script: deterministic checks for the
 * off-by-one `last` bug-fix case.
 *
 * This is a standalone, manually invoked case-specific test script — not a
 * runner abstraction. Invoke it with the repository's existing tsx toolchain
 * and an explicit candidate fixture directory:
 *
 *   node --import tsx benchmarks/autonomy/corpus/v1/autonomy-v1-004/assert.ts <candidate-fixture-dir>
 *
 * `<candidate-fixture-dir>` must be the candidate's fixture directory
 * containing `index.ts` and `tsconfig.json`. Candidate files are resolved
 * only from this argument — never from the frozen fixture in this case
 * directory or from an assumed working-tree location.
 *
 * Contract:
 * - stdout receives exactly one JSON array: one `{ assertionId, passed }`
 *   object per declared identifier, in declared order (`final-element`,
 *   `existing-last-behavior`, `fixture-typecheck`). Nothing else is written
 *   to stdout.
 * - All diagnostics go to stderr.
 * - The exit status is 0 if and only if every declared assertion passes; it
 *   is nonzero for any failed assertion and for usage errors. Candidate load
 *   failures and compiler failures are reported as failed checks for the
 *   affected assertions — never as missing or fabricated results.
 * - Importing this module (for example by repository tests) performs no
 *   checks and produces no output; the checks run only when the script is
 *   executed directly.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Declared assertion identifiers, in the exact order reported on stdout. */
const ASSERTION_IDENTIFIERS = ["final-element", "existing-last-behavior", "fixture-typecheck"] as const;

type AssertionId = (typeof ASSERTION_IDENTIFIERS)[number];

interface AssertionOutcome {
  assertionId: AssertionId;
  passed: boolean;
}

/** Type of the candidate's exported `last`, if the import succeeded. */
type LastFunction = <T>(values: readonly T[]) => T | undefined;

const caseDirectory = path.dirname(fileURLToPath(import.meta.url));

/**
 * Repository root, resolved relative to this assertion script (five
 * directory levels up from the case directory).
 */
const repositoryRoot = path.join(caseDirectory, "..", "..", "..", "..", "..");

function diagnostic(message: string): void {
  process.stderr.write(`[autonomy-v1-004 assert] ${message}\n`);
}

/**
 * Dynamically import the candidate fixture from the explicit candidate
 * directory and return its exported `last`, or `undefined` (with a stderr
 * diagnostic) when the candidate cannot be loaded or does not export the
 * expected function.
 */
async function importCandidateLast(candidateDir: string): Promise<LastFunction | undefined> {
  const indexFile = path.join(candidateDir, "index.ts");
  if (!existsSync(indexFile)) {
    diagnostic(`candidate fixture entry not found: ${indexFile}`);
    return undefined;
  }
  let module: unknown;
  try {
    module = await import(pathToFileURL(indexFile).href);
  } catch (error) {
    diagnostic(`failed to load candidate fixture ${indexFile}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  if (typeof module !== "object" || module === null) {
    diagnostic("candidate fixture module namespace is not an object");
    return undefined;
  }
  const exported = (module as Record<string, unknown>).last;
  if (typeof exported !== "function") {
    diagnostic("candidate fixture does not export a `last` function");
    return undefined;
  }
  return exported as LastFunction;
}

/**
 * `final-element`: the requested bug fix must be present — `last` returns
 * the final element of nonempty arrays, checked with strict equality.
 */
function checkFinalElement(last: LastFunction): boolean {
  const expectations: ReadonlyArray<{ values: ReadonlyArray<unknown>; expected: unknown }> = [
    { values: [1, 2, 3], expected: 3 },
    { values: ["a", "b", "c"], expected: "c" },
  ];
  let allPass = true;
  for (const { values, expected } of expectations) {
    let result: unknown;
    try {
      result = last(values);
    } catch (error) {
      diagnostic(`last([${values.join(",")}]) threw: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (result !== expected) {
      diagnostic(`last([${values.join(",")}]) returned ${String(result)}; expected ${String(expected)}`);
      allPass = false;
    }
  }
  return allPass;
}

/**
 * `existing-last-behavior`: the pristine behavior must be preserved —
 * `last([])` returns `undefined`, `last([5])` returns `5`, a single object
 * value is returned by identity, and calling `last` on a supplied
 * multi-element array leaves its length, ordering, and element identities
 * unchanged.
 */
function checkExistingLastBehavior(last: LastFunction): boolean {
  let emptyResult: unknown;
  try {
    emptyResult = last([]);
  } catch (error) {
    diagnostic(`last([]) threw: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (emptyResult !== undefined) {
    diagnostic(`last([]) returned ${String(emptyResult)}; expected undefined`);
    return false;
  }

  let singleResult: unknown;
  try {
    singleResult = last([5]);
  } catch (error) {
    diagnostic(`last([5]) threw: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (singleResult !== 5) {
    diagnostic(`last([5]) returned ${String(singleResult)}; expected 5`);
    return false;
  }

  const singleObject = { value: 7 };
  let identityResult: unknown;
  try {
    identityResult = last([singleObject]);
  } catch (error) {
    diagnostic(`last([singleObject]) threw: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (identityResult !== singleObject) {
    diagnostic(`last([singleObject]) did not return the supplied object by identity`);
    return false;
  }

  const first = { position: 0 };
  const second = { position: 1 };
  const third = { position: 2 };
  const values = [first, second, third];
  try {
    last(values);
  } catch (error) {
    diagnostic(`last([first, second, third]) threw: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (values.length !== 3) {
    diagnostic(`supplied array length changed to ${String(values.length)}; expected 3`);
    return false;
  }
  if (values[0] !== first) {
    diagnostic("supplied array element 0 is no longer the original first element");
    return false;
  }
  if (values[1] !== second) {
    diagnostic("supplied array element 1 is no longer the original second element");
    return false;
  }
  if (values[2] !== third) {
    diagnostic("supplied array element 2 is no longer the original third element");
    return false;
  }
  return true;
}

/**
 * `fixture-typecheck`: run the already installed TypeScript compiler against
 * the candidate fixture's standalone `tsconfig.json`, using `process.execPath`
 * with no shell and no package download. A zero compiler exit status is the
 * only passing evidence; a missing compiler, a missing tsconfig, a spawn
 * failure, or a nonzero exit is a failed check.
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
      diagnostic(`failed to run fixture typecheck: ${error.message}`);
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
  const last = await importCandidateLast(candidateDir);
  if (last === undefined) {
    // A candidate that cannot be loaded cannot evidence either behavioral
    // assertion; both are reported as failed, not missing.
    outcomes.set("final-element", false);
    outcomes.set("existing-last-behavior", false);
  } else {
    outcomes.set("final-element", checkFinalElement(last));
    outcomes.set("existing-last-behavior", checkExistingLastBehavior(last));
  }
  outcomes.set("fixture-typecheck", await runFixtureTypecheck(candidateDir));
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
