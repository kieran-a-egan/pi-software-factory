/**
 * autonomy-v1-006 local assertion script: deterministic checks for the
 * truthiness-based `filterDefined` bug-fix case.
 *
 * This is a standalone, manually invoked case-specific test script — not a
 * runner abstraction. Invoke it with the repository's existing tsx toolchain
 * and an explicit candidate fixture directory:
 *
 *   node --import tsx benchmarks/autonomy/corpus/v1/autonomy-v1-006/assert.ts <candidate-fixture-dir>
 *
 * `<candidate-fixture-dir>` must be the candidate's fixture directory
 * containing `index.ts` and `tsconfig.json`. Candidate files are resolved
 * only from this argument — never from the frozen fixture in this case
 * directory or from an assumed working-tree location.
 *
 * Contract:
 * - stdout receives exactly one JSON array: one `{ assertionId, passed }`
 *   object per declared identifier, in declared order (`preserves-falsy-values`,
 *   `existing-nullish-filtering`, `fixture-typecheck`). Nothing else is written
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
  "preserves-falsy-values",
  "existing-nullish-filtering",
  "fixture-typecheck",
] as const;

type AssertionId = (typeof ASSERTION_IDENTIFIERS)[number];

interface AssertionOutcome {
  assertionId: AssertionId;
  passed: boolean;
}

/** Type of the candidate's exported `filterDefined`, if the import succeeded. */
type FilterDefinedFunction = <T>(values: readonly (T | null | undefined)[]) => T[];

const caseDirectory = path.dirname(fileURLToPath(import.meta.url));

/**
 * Repository root, resolved relative to this assertion script (five
 * directory levels up from the case directory).
 */
const repositoryRoot = path.join(caseDirectory, "..", "..", "..", "..", "..");

function diagnostic(message: string): void {
  process.stderr.write(`[autonomy-v1-006 assert] ${message}\n`);
}

/**
 * Deep structural equality for the candidate's array results, using Node's
 * built-in `isDeepStrictEqual` so that comparisons are value-based, never
 * identity-based. Unlike a hand-rolled `every`-based comparison, it treats
 * missing array elements (holes in sparse arrays) as distinct from defined
 * values, so a sparse result with the right `length` cannot pass, and a
 * mutation that deletes an element without changing `length` is detected.
 * Retained-identity evidence is checked separately with `===`, because
 * structural equality alone cannot establish that the same object
 * references were retained.
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
 * directory and return its exported `filterDefined`, or `undefined` (with a
 * stderr diagnostic) when the candidate cannot be loaded or does not export
 * the expected function.
 */
async function importCandidateFilterDefined(candidateDir: string): Promise<FilterDefinedFunction | undefined> {
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
  const exported = (module as Record<string, unknown>).filterDefined;
  if (typeof exported !== "function") {
    diagnostic("candidate fixture does not export a `filterDefined` function");
    return undefined;
  }
  return exported as FilterDefinedFunction;
}

/**
 * `preserves-falsy-values`: the requested bug fix must be present —
 * `filterDefined` retains legitimate falsy values (`0`, `false`, `''`)
 * alongside defined truthy values, dropping only `null` and `undefined`,
 * checked with deep array comparison.
 */
function checkPreservesFalsyValues(filterDefined: FilterDefinedFunction): boolean {
  const expectations: ReadonlyArray<{ values: ReadonlyArray<unknown>; expected: ReadonlyArray<unknown> }> = [
    { values: [0, 1, null], expected: [0, 1] },
    { values: [false, true, undefined], expected: [false, true] },
    { values: ["", "x", null], expected: ["", "x"] },
  ];
  let allPass = true;
  for (const { values, expected } of expectations) {
    let result: unknown;
    try {
      result = filterDefined(values);
    } catch (error) {
      diagnostic(`filterDefined(${describeValue(values)}) threw: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (!deepEqual(result, expected)) {
      diagnostic(
        `filterDefined(${describeValue(values)}) returned ${describeValue(result)}; expected ${describeValue(expected)} (falsy values preserved)`,
      );
      allPass = false;
    }
  }
  return allPass;
}

/**
 * `existing-nullish-filtering`: the pristine behavior must be preserved —
 * `filterDefined([])` returns `[]`, `filterDefined([1, null, 2, undefined])`
 * returns `[1, 2]`, and a nontrivial mixed input retains the original
 * relative order of the kept values, all checked with deep array comparison.
 * Retained object elements must be the very same references that were
 * supplied (checked with `===`, not structural equality), and calling
 * `filterDefined` on a supplied array must leave that array itself
 * unchanged, checked against a snapshot taken before the invocation plus
 * explicit reference checks on its object elements.
 */
function checkExistingNullishFiltering(filterDefined: FilterDefinedFunction): boolean {
  const expectations: ReadonlyArray<{ values: ReadonlyArray<unknown>; expected: ReadonlyArray<unknown> }> = [
    { values: [], expected: [] },
    { values: [1, null, 2, undefined], expected: [1, 2] },
    { values: [9, null, 3, undefined, 5, null, 3], expected: [9, 3, 5, 3] },
  ];
  for (const { values, expected } of expectations) {
    let result: unknown;
    try {
      result = filterDefined(values);
    } catch (error) {
      diagnostic(`filterDefined(${describeValue(values)}) threw: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (!deepEqual(result, expected)) {
      diagnostic(
        `filterDefined(${describeValue(values)}) returned ${describeValue(result)}; expected ${describeValue(expected)}`,
      );
      return false;
    }
  }

  // Object reference identity: the retained elements must be the supplied
  // object references themselves, not deep-equal copies.
  const objectA = { id: "a" };
  const objectB = { id: "b" };
  const objectInput: (typeof objectA | null | undefined)[] = [objectA, null, objectB, undefined];
  let objectResult: unknown;
  try {
    objectResult = filterDefined(objectInput);
  } catch (error) {
    diagnostic(`filterDefined([objectA, null, objectB, undefined]) threw: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (!Array.isArray(objectResult) || objectResult.length !== 2) {
    diagnostic(`object input produced ${describeValue(objectResult)}; expected an array of the two supplied objects`);
    return false;
  }
  if (objectResult[0] !== objectA || objectResult[1] !== objectB) {
    diagnostic(
      `retained object elements are not the supplied references: got [${describeValue(objectResult[0])}, ${describeValue(objectResult[1])}]; expected the original object references`,
    );
    return false;
  }

  // No mutation of the supplied input: compare against a snapshot saved
  // before the call, and verify the object element by reference (a
  // deep-equal replacement would not be caught by the snapshot check).
  const input: (typeof objectA | number | string | null | undefined)[] = [0, null, "x", undefined, objectA];
  const savedCopy = [...input];
  try {
    filterDefined(input);
  } catch (error) {
    diagnostic(`filterDefined([0, null, "x", undefined, objectA]) threw: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (!deepEqual(input, savedCopy)) {
    diagnostic(
      `supplied array was mutated: after filterDefined([0, null, "x", undefined, objectA]) it is ${describeValue(input)}; expected the saved copy ${describeValue(savedCopy)}`,
    );
    return false;
  }
  if (input[4] !== objectA) {
    diagnostic(`supplied array's object element changed identity after the call: got ${describeValue(input[4])}; expected the original reference`);
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
  const filterDefined = await importCandidateFilterDefined(candidateDir);
  if (filterDefined === undefined) {
    // A candidate that cannot be loaded cannot evidence either behavioral
    // assertion; both are reported as failed, not missing.
    outcomes.set("preserves-falsy-values", false);
    outcomes.set("existing-nullish-filtering", false);
  } else {
    outcomes.set("preserves-falsy-values", checkPreservesFalsyValues(filterDefined));
    outcomes.set("existing-nullish-filtering", checkExistingNullishFiltering(filterDefined));
  }
  outcomes.set("fixture-typecheck", await runFixtureTypecheck(candidateDir));
  return outcomes;
}

async function main(): Promise<number> {
  // Exactly one positional argument is accepted: a second (or further)
  // candidate directory would be silently ignored, so it is rejected along
  // with the missing-argument case as a usage error.
  if (process.argv.length !== 3) {
    diagnostic("usage: node --import tsx assert.ts <candidate-fixture-dir>");
    return 2;
  }
  const candidateDir = path.resolve(process.argv[2]);
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
