/**
 * autonomy-v1-005 local assertion script: deterministic checks for the
 * first-occurrence-order `unique` bug-fix case.
 *
 * This is a standalone, manually invoked case-specific test script — not a
 * runner abstraction. Invoke it with the repository's existing tsx toolchain
 * and an explicit candidate fixture directory:
 *
 *   node --import tsx benchmarks/autonomy/corpus/v1/autonomy-v1-005/assert.ts <candidate-fixture-dir>
 *
 * `<candidate-fixture-dir>` must be the candidate's fixture directory
 * containing `index.ts` and `tsconfig.json`. Candidate files are resolved
 * only from this argument — never from the frozen fixture in this case
 * directory or from an assumed working-tree location.
 *
 * Contract:
 * - stdout receives exactly one JSON array: one `{ assertionId, passed }`
 *   object per declared identifier, in declared order (`first-occurrence-order`,
 *   `existing-unique-behavior`, `fixture-typecheck`). Nothing else is written
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
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Declared assertion identifiers, in the exact order reported on stdout. */
const ASSERTION_IDENTIFIERS = [
  "first-occurrence-order",
  "existing-unique-behavior",
  "fixture-typecheck",
] as const;

type AssertionId = (typeof ASSERTION_IDENTIFIERS)[number];

interface AssertionOutcome {
  assertionId: AssertionId;
  passed: boolean;
}

/** Type of the candidate's exported `unique`, if the import succeeded. */
type UniqueFunction = (values: readonly string[]) => string[];

const caseDirectory = path.dirname(fileURLToPath(import.meta.url));

/**
 * Repository root, resolved relative to this assertion script (five
 * directory levels up from the case directory).
 */
const repositoryRoot = path.join(caseDirectory, "..", "..", "..", "..", "..");

function diagnostic(message: string): void {
  process.stderr.write(`[autonomy-v1-005 assert] ${message}\n`);
}

/**
 * Deep structural equality for the candidate's array results, using Node's
 * built-in `isDeepStrictEqual` so that comparisons are value-based, never
 * identity-based. Unlike a hand-rolled `every`-based comparison, it treats
 * missing array elements (holes in sparse arrays) as distinct from defined
 * values, so a sparse result with the right `length` cannot pass, and a
 * mutation that deletes an element without changing `length` is detected.
 */
function deepEqual(actual: unknown, expected: unknown): boolean {
  return isDeepStrictEqual(actual, expected);
}

function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Dynamically import the candidate fixture from the explicit candidate
 * directory and return its exported `unique`, or `undefined` (with a stderr
 * diagnostic) when the candidate cannot be loaded or does not export the
 * expected function.
 */
async function importCandidateUnique(candidateDir: string): Promise<UniqueFunction | undefined> {
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
  const exported = (module as Record<string, unknown>).unique;
  if (typeof exported !== "function") {
    diagnostic("candidate fixture does not export a `unique` function");
    return undefined;
  }
  return exported as UniqueFunction;
}

/**
 * `first-occurrence-order`: the requested bug fix must be present —
 * `unique` preserves the first-occurrence order of the input values in its
 * result, checked with deep array comparison.
 */
function checkFirstOccurrenceOrder(unique: UniqueFunction): boolean {
  const expectations: ReadonlyArray<{ values: ReadonlyArray<string>; expected: ReadonlyArray<string> }> = [
    { values: ["b", "a", "b"], expected: ["b", "a"] },
    { values: ["x", "x", "y", "x", "z", "y"], expected: ["x", "y", "z"] },
  ];
  let allPass = true;
  for (const { values, expected } of expectations) {
    let result: unknown;
    try {
      result = unique(values);
    } catch (error) {
      diagnostic(`unique([${values.join(",")}]) threw: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (!deepEqual(result, expected)) {
      diagnostic(
        `unique([${values.join(",")}]) returned ${describeValue(result)}; expected ${describeValue(expected)} (first-occurrence order)`,
      );
      allPass = false;
    }
  }
  return allPass;
}

/**
 * `existing-unique-behavior`: the pristine behavior must be preserved —
 * `unique([])` returns `[]`, a singleton input returns that singleton, and
 * `unique(["a", "A", "a"])` returns `["a", "A"]` (duplicates are removed
 * using exact case-sensitive comparison), all checked with deep array
 * comparison. Finally, calling `unique` on a supplied duplicate-containing
 * array must leave the supplied array itself unchanged, checked against a
 * saved copy made before the invocation.
 */
function checkExistingUniqueBehavior(unique: UniqueFunction): boolean {
  const expectations: ReadonlyArray<{ values: ReadonlyArray<string>; expected: ReadonlyArray<string> }> = [
    { values: [], expected: [] },
    { values: ["a"], expected: ["a"] },
    { values: ["a", "A", "a"], expected: ["a", "A"] },
  ];
  for (const { values, expected } of expectations) {
    let result: unknown;
    try {
      result = unique(values);
    } catch (error) {
      diagnostic(`unique([${values.join(",")}]) threw: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (!deepEqual(result, expected)) {
      diagnostic(
        `unique([${values.join(",")}]) returned ${describeValue(result)}; expected ${describeValue(expected)}`,
      );
      return false;
    }
  }

  const input = ["d", "c", "d", "b"];
  const savedCopy = [...input];
  try {
    unique(input);
  } catch (error) {
    diagnostic(`unique(["d", "c", "d", "b"]) threw: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (!deepEqual(input, savedCopy)) {
    diagnostic(
      `supplied array was mutated: after unique(["d", "c", "d", "b"]) it is ${describeValue(input)}; expected the saved copy ${describeValue(savedCopy)}`,
    );
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
  const unique = await importCandidateUnique(candidateDir);
  if (unique === undefined) {
    // A candidate that cannot be loaded cannot evidence either behavioral
    // assertion; both are reported as failed, not missing.
    outcomes.set("first-occurrence-order", false);
    outcomes.set("existing-unique-behavior", false);
  } else {
    outcomes.set("first-occurrence-order", checkFirstOccurrenceOrder(unique));
    outcomes.set("existing-unique-behavior", checkExistingUniqueBehavior(unique));
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
