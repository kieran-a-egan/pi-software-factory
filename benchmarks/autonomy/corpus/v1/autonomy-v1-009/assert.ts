/**
 * autonomy-v1-009 local assertion script: deterministic checks for the
 * exclusive-end `sliceInclusive` bug-fix case.
 *
 * This is a standalone, manually invoked case-specific test script — not a
 * runner abstraction. Invoke it with the repository's existing tsx toolchain
 * and an explicit candidate fixture directory:
 *
 *   node --import tsx benchmarks/autonomy/corpus/v1/autonomy-v1-009/assert.ts <candidate-fixture-dir>
 *
 * `<candidate-fixture-dir>` must be the candidate's fixture directory
 * containing `index.ts` and `tsconfig.json`. Candidate files are resolved
 * only from this argument — never from the frozen fixture in this case
 * directory or from an assumed working-tree location.
 *
 * Contract:
 * - stdout receives exactly one JSON array: one `{ assertionId, passed }`
 *   object per declared identifier, in declared order (`inclusive-end`,
 *   `existing-slice-behavior`, `fixture-typecheck`). Nothing else is written
 *   to stdout.
 * - All diagnostics, including compiler output, go to stderr.
 * - The exit status is 0 if and only if every declared assertion passes; it
 *   is nonzero for any failed assertion and for usage errors. Candidate load
 *   failures and compiler failures are reported as failed checks for the
 *   affected assertions — never as missing, fabricated, or passing results.
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
  "inclusive-end",
  "existing-slice-behavior",
  "fixture-typecheck",
] as const;

type AssertionId = (typeof ASSERTION_IDENTIFIERS)[number];

interface AssertionOutcome {
  assertionId: AssertionId;
  passed: boolean;
}

/** Type of the candidate's exported `sliceInclusive`, if the import succeeded. */
type SliceInclusiveFunction = <T>(values: readonly T[], start: number, end: number) => T[];

const caseDirectory = path.dirname(fileURLToPath(import.meta.url));

/**
 * Repository root, resolved relative to this assertion script (five
 * directory levels up from the case directory).
 */
const repositoryRoot = path.join(caseDirectory, "..", "..", "..", "..", "..");

function diagnostic(message: string): void {
  process.stderr.write(`[autonomy-v1-009 assert] ${message}\n`);
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
 * directory and return its exported `sliceInclusive`, or `undefined` (with a
 * stderr diagnostic) when the candidate cannot be loaded or does not export
 * the expected function.
 */
async function importCandidateSliceInclusive(candidateDir: string): Promise<SliceInclusiveFunction | undefined> {
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
  const exported = (module as Record<string, unknown>).sliceInclusive;
  if (typeof exported !== "function") {
    diagnostic("candidate fixture does not export a `sliceInclusive` function");
    return undefined;
  }
  return exported as SliceInclusiveFunction;
}

/**
 * One behavioral expectation: `sliceInclusive(values, start, end)` must
 * deep-equal `expected`, compared with `isDeepStrictEqual` — never JSON
 * serialization or a shallow comparison.
 */
interface SliceExpectation {
  values: unknown[];
  start: number;
  end: number;
  expected: unknown[];
}

function describeCall({ values, start, end }: { values: readonly unknown[]; start: number; end: number }): string {
  return `sliceInclusive(${describeValue(values)}, ${start}, ${end})`;
}

/**
 * `inclusive-end`: the requested bug fix must be present — the element at
 * the supplied end index is included in the result. The expectations cover a
 * mid-range end (`['a', 'b', 'c', 'd'], 1, 2 -> ['b', 'c']`, which also
 * excludes the value before the start and the value after the end), a
 * zero-start end (`[10, 20, 30], 0, 1 -> [10, 20]`), and a singleton range
 * where start equals end (`[10, 20, 30], 1, 1 -> [20]`).
 */
function checkInclusiveEnd(sliceInclusive: SliceInclusiveFunction): boolean {
  const expectations: readonly SliceExpectation[] = [
    { values: ["a", "b", "c", "d"], start: 1, end: 2, expected: ["b", "c"] },
    { values: [10, 20, 30], start: 0, end: 1, expected: [10, 20] },
    { values: [10, 20, 30], start: 1, end: 1, expected: [20] },
  ];
  let allPass = true;
  for (const expectation of expectations) {
    const callText = describeCall(expectation);
    let result: unknown;
    try {
      result = sliceInclusive(expectation.values, expectation.start, expectation.end);
    } catch (error) {
      diagnostic(`inclusive-end: ${callText} threw: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (!isDeepStrictEqual(result, expectation.expected)) {
      diagnostic(`inclusive-end: ${callText} returned ${describeValue(result)}; expected ${describeValue(expectation.expected)}`);
      allPass = false;
    }
  }
  return allPass;
}

/**
 * For one `sliceInclusive` invocation, verify that the supplied input array
 * is unchanged (compared with `isDeepStrictEqual` against an independent
 * pre-call snapshot, plus by reference for each supplied object element) and
 * that the result is a fresh array distinct from the input. Returns `true`
 * when both properties hold; otherwise writes a diagnostic and returns
 * `false`.
 */
function verifyInputUntouchedAndResultFresh(
  callText: string,
  input: readonly unknown[],
  savedCopy: readonly unknown[],
  inputElementReferences: readonly (object | undefined)[],
  result: unknown,
): boolean {
  let ok = true;
  if (!isDeepStrictEqual(input, savedCopy)) {
    diagnostic(
      `existing-slice-behavior: ${callText} mutated the supplied input: it is now ${describeValue(input)}; expected the pre-call snapshot ${describeValue(savedCopy)}`,
    );
    ok = false;
  }
  for (let index = 0; index < inputElementReferences.length; index += 1) {
    const reference = inputElementReferences[index];
    if (reference !== undefined && input[index] !== reference) {
      diagnostic(
        `existing-slice-behavior: ${callText} replaced supplied input element ${index} by reference: got ${describeValue(input[index])}; expected the original reference`,
      );
      ok = false;
    }
  }
  if (result === input) {
    diagnostic(`existing-slice-behavior: ${callText} returned the supplied input array itself instead of a fresh array`);
    ok = false;
  }
  return ok;
}

/**
 * `existing-slice-behavior`: the pristine behavior must be preserved —
 * `sliceInclusive([], 0, 0)` returns `[]`, a beyond-length end is handled as
 * in `Array.prototype.slice` (`[10, 20, 30], 1, 99 -> [20, 30]`), and a
 * nonzero-start object-array call with a beyond-length end retains the
 * supplied object references at the same positions in the same order. Every
 * call compares the input against an independent pre-call snapshot (no
 * mutation) and verifies the result is a fresh array distinct from the
 * input, including the empty-input call. A bounded nonzero-start call whose
 * end membership is exactly the disputed behavior asserts only
 * non-mutation and result freshness, never which elements are retained. All
 * value comparisons use `isDeepStrictEqual`.
 */
function checkExistingSliceBehavior(sliceInclusive: SliceInclusiveFunction): boolean {
  const expectations: readonly SliceExpectation[] = [
    // Empty input produces an empty result.
    { values: [], start: 0, end: 0, expected: [] },
    // A beyond-length end is handled as in Array.prototype.slice.
    { values: [10, 20, 30], start: 1, end: 99, expected: [20, 30] },
  ];
  let allPass = true;
  for (const expectation of expectations) {
    const callText = describeCall(expectation);
    // Independent pre-call snapshot: the input must be unchanged after the
    // call, in every case including the empty-input case.
    const savedCopy: readonly unknown[] = [...expectation.values];
    let result: unknown;
    try {
      result = sliceInclusive(expectation.values, expectation.start, expectation.end);
    } catch (error) {
      diagnostic(`existing-slice-behavior: ${callText} threw: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (!verifyInputUntouchedAndResultFresh(callText, expectation.values, savedCopy, [], result)) {
      allPass = false;
      continue;
    }
    if (!isDeepStrictEqual(result, expectation.expected)) {
      diagnostic(`existing-slice-behavior: ${callText} returned ${describeValue(result)}; expected ${describeValue(expectation.expected)}`);
      allPass = false;
    }
  }

  // Object array with a nonzero start and a beyond-length end: the retained
  // elements must be the very same references, at the same positions, in the
  // same order. The beyond-length end clamps to the final index under both
  // the pristine (exclusive) and a corrected (inclusive) interpretation, so
  // this expectation is unaffected by the disputed end membership.
  const objectA = { id: 1 };
  const objectB = { id: 2 };
  const objectC = { id: 3 };
  const objectD = { id: 4 };
  const objectValues: object[] = [objectA, objectB, objectC, objectD];
  const objectSavedCopy: readonly object[] = [...objectValues];
  const objectReferences: readonly (object | undefined)[] = [objectA, objectB, objectC, objectD];
  const objectCallText = describeCall({ values: objectValues, start: 1, end: 99 });
  let objectResult: unknown;
  try {
    objectResult = sliceInclusive(objectValues, 1, 99);
  } catch (error) {
    diagnostic(`existing-slice-behavior: ${objectCallText} threw: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (!verifyInputUntouchedAndResultFresh(objectCallText, objectValues, objectSavedCopy, objectReferences, objectResult)) {
    allPass = false;
  } else if (!Array.isArray(objectResult) || objectResult.length !== 3) {
    diagnostic(
      `existing-slice-behavior: ${objectCallText} produced ${describeValue(objectResult)}; expected an array of the three supplied objects`,
    );
    allPass = false;
  } else if (objectResult[0] !== objectB || objectResult[1] !== objectC || objectResult[2] !== objectD) {
    diagnostic(
      `existing-slice-behavior: ${objectCallText} did not retain the supplied object references at their positions in order: got [${describeValue(objectResult[0])}, ${describeValue(objectResult[1])}, ${describeValue(objectResult[2])}]`,
    );
    allPass = false;
  }

  // Bounded nonzero-start call whose end membership is exactly the disputed
  // behavior: `sliceInclusive([10, 20, 30, 40], 1, 2)` yields `[20]` under
  // the pristine exclusive-end interpretation and `[20, 30]` under a
  // corrected inclusive-end interpretation. Assert only non-mutation and
  // result freshness — never which elements are retained.
  const boundedValues: number[] = [10, 20, 30, 40];
  const boundedSavedCopy: readonly number[] = [...boundedValues];
  const boundedCallText = describeCall({ values: boundedValues, start: 1, end: 2 });
  let boundedResult: unknown;
  try {
    boundedResult = sliceInclusive(boundedValues, 1, 2);
  } catch (error) {
    diagnostic(`existing-slice-behavior: ${boundedCallText} threw: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (!verifyInputUntouchedAndResultFresh(boundedCallText, boundedValues, boundedSavedCopy, [], boundedResult)) {
    allPass = false;
  }
  return allPass;
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
  const sliceInclusive = await importCandidateSliceInclusive(candidateDir);
  if (sliceInclusive === undefined) {
    // A candidate that cannot be loaded cannot evidence either behavioral
    // assertion; both are reported as failed, not missing.
    outcomes.set("inclusive-end", false);
    outcomes.set("existing-slice-behavior", false);
  } else {
    outcomes.set("inclusive-end", checkInclusiveEnd(sliceInclusive));
    outcomes.set("existing-slice-behavior", checkExistingSliceBehavior(sliceInclusive));
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
    // A usage error is still a direct invocation, so it reports the three
    // declared assertions — all failed — rather than writing nothing to
    // stdout. No candidate is loaded.
    const usageReport: AssertionOutcome[] = ASSERTION_IDENTIFIERS.map((assertionId) => ({
      assertionId,
      passed: false,
    }));
    process.stdout.write(`${JSON.stringify(usageReport, null, 2)}\n`);
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
