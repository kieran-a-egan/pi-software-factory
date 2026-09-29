/**
 * autonomy-v1-010 local assertion script: deterministic checks for the
 * omitted-partial-final-chunk bug-fix case.
 *
 * This is a standalone, manually invoked case-specific test script — not a
 * runner abstraction. Invoke it with the repository's existing tsx toolchain
 * and an explicit candidate fixture directory:
 *
 *   node --import tsx benchmarks/autonomy/corpus/v1/autonomy-v1-010/assert.ts <candidate-fixture-dir>
 *
 * `<candidate-fixture-dir>` must be the candidate's fixture directory
 * containing `index.ts` and `tsconfig.json`. Candidate files are resolved
 * only from this argument — never from the frozen fixture in this case
 * directory or from an assumed working-tree location.
 *
 * Contract:
 * - stdout receives exactly one JSON array: one `{ assertionId, passed }`
 *   object per declared identifier, in declared order (`partial-final-chunk`,
 *   `existing-chunk-behavior`, `fixture-typecheck`). Nothing else is written
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
  "partial-final-chunk",
  "existing-chunk-behavior",
  "fixture-typecheck",
] as const;

type AssertionId = (typeof ASSERTION_IDENTIFIERS)[number];

interface AssertionOutcome {
  assertionId: AssertionId;
  passed: boolean;
}

/** Type of the candidate's exported `chunk`, if the import succeeded. */
type ChunkFunction = <T>(values: readonly T[], size: number) => T[][];

const caseDirectory = path.dirname(fileURLToPath(import.meta.url));

/**
 * Repository root, resolved relative to this assertion script (five
 * directory levels up from the case directory).
 */
const repositoryRoot = path.join(caseDirectory, "..", "..", "..", "..", "..");

function diagnostic(message: string): void {
  process.stderr.write(`[autonomy-v1-010 assert] ${message}\n`);
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
 * directory and return its exported `chunk`, or `undefined` (with a stderr
 * diagnostic) when the candidate cannot be loaded or does not export the
 * expected function.
 */
async function importCandidateChunk(candidateDir: string): Promise<ChunkFunction | undefined> {
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
  const exported = (module as Record<string, unknown>).chunk;
  if (typeof exported !== "function") {
    diagnostic("candidate fixture does not export a `chunk` function");
    return undefined;
  }
  return exported as ChunkFunction;
}

/** One behavioral expectation: `chunk(values, size)` must deep-equal `expected`. */
interface ChunkExpectation {
  values: unknown[];
  size: number;
  expected: unknown[];
}

function describeCall({ values, size }: { values: readonly unknown[]; size: number }): string {
  return `chunk(${describeValue(values)}, ${size})`;
}

/**
 * `partial-final-chunk`: the requested bug fix must be present — when the
 * input length is not a multiple of `size`, the trailing incomplete window
 * is retained as a final chunk. The expectations cover
 * `chunk([1, 2, 3, 4, 5], 2) -> [[1, 2], [3, 4], [5]]`,
 * `chunk(['a', 'b', 'c'], 2) -> [['a', 'b'], ['c']]`, and
 * `chunk([1, 2, 3, 4], 3) -> [[1, 2, 3], [4]]`.
 */
function checkPartialFinalChunk(chunk: ChunkFunction): boolean {
  const expectations: readonly ChunkExpectation[] = [
    { values: [1, 2, 3, 4, 5], size: 2, expected: [[1, 2], [3, 4], [5]] },
    { values: ["a", "b", "c"], size: 2, expected: [["a", "b"], ["c"]] },
    { values: [1, 2, 3, 4], size: 3, expected: [[1, 2, 3], [4]] },
  ];
  let allPass = true;
  for (const expectation of expectations) {
    const callText = describeCall(expectation);
    let result: unknown;
    try {
      result = chunk(expectation.values, expectation.size);
    } catch (error) {
      diagnostic(`partial-final-chunk: ${callText} threw: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (!isDeepStrictEqual(result, expectation.expected)) {
      diagnostic(`partial-final-chunk: ${callText} returned ${describeValue(result)}; expected ${describeValue(expectation.expected)}`);
      allPass = false;
    }
  }
  return allPass;
}

/**
 * Verify that the supplied input array is unchanged after a `chunk` call —
 * compared with `isDeepStrictEqual` against an independent pre-call snapshot
 * and, for object elements, by reference against the saved originals — and
 * return `true` when the input is untouched.
 */
function verifyInputUntouched(
  callText: string,
  input: readonly unknown[],
  savedCopy: readonly unknown[],
  inputElementReferences: readonly (object | undefined)[],
): boolean {
  let ok = true;
  if (!isDeepStrictEqual(input, savedCopy)) {
    diagnostic(
      `existing-chunk-behavior: ${callText} mutated the supplied input: it is now ${describeValue(input)}; expected the pre-call snapshot ${describeValue(savedCopy)}`,
    );
    ok = false;
  }
  for (let index = 0; index < inputElementReferences.length; index += 1) {
    const reference = inputElementReferences[index];
    if (reference !== undefined && input[index] !== reference) {
      diagnostic(
        `existing-chunk-behavior: ${callText} replaced supplied input element ${index} by reference: got ${describeValue(input[index])}; expected the original reference`,
      );
      ok = false;
    }
  }
  return ok;
}

/**
 * Verify that a `chunk` result is a fresh outer array distinct from the
 * input, that every inner chunk is a fresh array distinct from the input,
 * and that the inner chunks are distinct from one another. Returns `true`
 * when all freshness properties hold.
 */
function verifyResultFresh(callText: string, input: readonly unknown[], result: unknown): boolean {
  let ok = true;
  if (!Array.isArray(result)) {
    diagnostic(`existing-chunk-behavior: ${callText} returned ${describeValue(result)}; expected an array of chunk arrays`);
    return false;
  }
  if (result === input) {
    diagnostic(`existing-chunk-behavior: ${callText} returned the supplied input array itself instead of a fresh outer array`);
    ok = false;
  }
  for (let index = 0; index < result.length; index += 1) {
    const inner = result[index];
    if (!Array.isArray(inner)) {
      diagnostic(`existing-chunk-behavior: ${callText} chunk ${index} is ${describeValue(inner)}; expected an array`);
      ok = false;
      continue;
    }
    if (inner === input) {
      diagnostic(`existing-chunk-behavior: ${callText} chunk ${index} is the supplied input array itself instead of a fresh array`);
      ok = false;
      continue;
    }
    for (let other = index + 1; other < result.length; other += 1) {
      if (result[other] === inner) {
        diagnostic(`existing-chunk-behavior: ${callText} chunks ${index} and ${other} share the same array reference`);
        ok = false;
      }
    }
  }
  return ok;
}

/**
 * `existing-chunk-behavior`: the pristine behavior must be preserved — an
 * empty input yields an empty result, the divisible input `[1, 2, 3, 4]` at
 * size 2 yields exactly its complete chunks in order, and `[1, 2]` at size
 * 1 yields one singleton chunk per element. Every call compares the input
 * against an independent pre-call snapshot (no mutation) and verifies the
 * result is a fresh outer array whose inner chunks are fresh, distinct
 * arrays distinct from the input. A divisible object input verifies that the
 * retained elements are the very same references, at the same positions, in
 * the same order. Per-call freshness is verified across repeated calls with
 * the same divisible input, and a nondivisible call asserts only
 * non-mutation and freshness — never final-chunk membership, which
 * `partial-final-chunk` owns. All value comparisons use
 * `isDeepStrictEqual`.
 */
function checkExistingChunkBehavior(chunk: ChunkFunction): boolean {
  const expectations: readonly ChunkExpectation[] = [
    // Empty input produces an empty result.
    { values: [], size: 2, expected: [] },
    // A divisible input yields exactly its complete chunks, in order.
    { values: [1, 2, 3, 4], size: 2, expected: [[1, 2], [3, 4]] },
    // Size 1 yields one singleton chunk per element.
    { values: [1, 2], size: 1, expected: [[1], [2]] },
  ];
  let allPass = true;
  for (const expectation of expectations) {
    const callText = describeCall(expectation);
    // Independent pre-call snapshot: the input must be unchanged after the
    // call, in every case including the empty-input case.
    const savedCopy: readonly unknown[] = [...expectation.values];
    let result: unknown;
    try {
      result = chunk(expectation.values, expectation.size);
    } catch (error) {
      diagnostic(`existing-chunk-behavior: ${callText} threw: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (!verifyInputUntouched(callText, expectation.values, savedCopy, [])) {
      allPass = false;
      continue;
    }
    if (!verifyResultFresh(callText, expectation.values, result)) {
      allPass = false;
      continue;
    }
    if (!isDeepStrictEqual(result, expectation.expected)) {
      diagnostic(`existing-chunk-behavior: ${callText} returned ${describeValue(result)}; expected ${describeValue(expectation.expected)}`);
      allPass = false;
    }
  }

  // Divisible object input: the retained elements must be the very same
  // references, at the same positions, in the same order. Because the input
  // length is a multiple of the size, this expectation is unaffected by the
  // disputed final-chunk membership.
  const objectA = { id: 1 };
  const objectB = { id: 2 };
  const objectC = { id: 3 };
  const objectD = { id: 4 };
  const objectValues: object[] = [objectA, objectB, objectC, objectD];
  const objectSavedCopy: readonly object[] = [...objectValues];
  const objectReferences: readonly (object | undefined)[] = [objectA, objectB, objectC, objectD];
  const objectCallText = describeCall({ values: objectValues, size: 2 });
  let objectResult: unknown;
  try {
    objectResult = chunk(objectValues, 2);
  } catch (error) {
    diagnostic(`existing-chunk-behavior: ${objectCallText} threw: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (!verifyInputUntouched(objectCallText, objectValues, objectSavedCopy, objectReferences)) {
    allPass = false;
  } else if (!verifyResultFresh(objectCallText, objectValues, objectResult)) {
    allPass = false;
  } else if (!Array.isArray(objectResult) || objectResult.length !== 2) {
    diagnostic(
      `existing-chunk-behavior: ${objectCallText} produced ${describeValue(objectResult)}; expected an array of the two complete object chunks`,
    );
    allPass = false;
  } else if (
    !Array.isArray(objectResult[0]) ||
    objectResult[0].length !== 2 ||
    !Array.isArray(objectResult[1]) ||
    objectResult[1].length !== 2 ||
    objectResult[0][0] !== objectA ||
    objectResult[0][1] !== objectB ||
    objectResult[1][0] !== objectC ||
    objectResult[1][1] !== objectD
  ) {
    diagnostic(
      `existing-chunk-behavior: ${objectCallText} did not retain the supplied object references at their positions in order: got ${describeValue(objectResult)}`,
    );
    allPass = false;
  }

  // Per-call freshness across repeated calls: two calls with the same
  // divisible input must each return a fresh outer array whose inner chunks
  // are fresh and distinct from the other call's chunks.
  const repeatValues: number[] = [1, 2, 3, 4];
  const repeatSavedCopy: readonly number[] = [...repeatValues];
  const repeatCallText = describeCall({ values: repeatValues, size: 2 });
  let firstResult: unknown;
  let secondResult: unknown;
  try {
    firstResult = chunk(repeatValues, 2);
    secondResult = chunk(repeatValues, 2);
  } catch (error) {
    diagnostic(`existing-chunk-behavior: ${repeatCallText} threw: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (!verifyInputUntouched(repeatCallText, repeatValues, repeatSavedCopy, [])) {
    allPass = false;
  } else if (!verifyResultFresh(repeatCallText, repeatValues, firstResult)) {
    allPass = false;
  } else if (!verifyResultFresh(repeatCallText, repeatValues, secondResult)) {
    allPass = false;
  } else {
    // Both freshness checks passed, so both results are arrays here.
    const first = firstResult as readonly unknown[];
    const second = secondResult as readonly unknown[];
    if (first === second) {
      diagnostic(`existing-chunk-behavior: ${repeatCallText} repeated with the same input returned the same outer array reference`);
      allPass = false;
    } else {
      // Compare every inner array of the second result against all inner
      // arrays of the first result, not just matching positions: a
      // candidate that reuses its inner buffers at different positions
      // (for example in reversed order, refilling them between calls)
      // would otherwise pass a position-by-position comparison.
      const firstInnerReferences: readonly unknown[] = first.filter((inner) => Array.isArray(inner));
      for (let index = 0; index < second.length; index += 1) {
        if (firstInnerReferences.includes(second[index])) {
          diagnostic(`existing-chunk-behavior: ${repeatCallText} repeated with the same input reused an inner chunk from the first call at position ${index}`);
          allPass = false;
        }
      }
    }
  }

  // Nondivisible call: final-chunk membership is owned by
  // `partial-final-chunk`, so assert only that the input is untouched and
  // the result is a fresh structure.
  const nondivisibleValues: number[] = [10, 20, 30];
  const nondivisibleSavedCopy: readonly number[] = [...nondivisibleValues];
  const nondivisibleCallText = describeCall({ values: nondivisibleValues, size: 2 });
  let nondivisibleResult: unknown;
  try {
    nondivisibleResult = chunk(nondivisibleValues, 2);
  } catch (error) {
    diagnostic(`existing-chunk-behavior: ${nondivisibleCallText} threw: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (!verifyInputUntouched(nondivisibleCallText, nondivisibleValues, nondivisibleSavedCopy, [])) {
    allPass = false;
  } else if (!verifyResultFresh(nondivisibleCallText, nondivisibleValues, nondivisibleResult)) {
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
  const chunk = await importCandidateChunk(candidateDir);
  if (chunk === undefined) {
    // A candidate that cannot be loaded cannot evidence either behavioral
    // assertion; both are reported as failed, not missing.
    outcomes.set("partial-final-chunk", false);
    outcomes.set("existing-chunk-behavior", false);
  } else {
    outcomes.set("partial-final-chunk", checkPartialFinalChunk(chunk));
    outcomes.set("existing-chunk-behavior", checkExistingChunkBehavior(chunk));
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
