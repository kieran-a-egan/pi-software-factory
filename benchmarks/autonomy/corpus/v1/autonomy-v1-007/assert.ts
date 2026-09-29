/**
 * autonomy-v1-007 local assertion script: deterministic checks for the
 * leading-prefix-stripping `stripPrefix` bug-fix case.
 *
 * This is a standalone, manually invoked case-specific test script — not a
 * runner abstraction. Invoke it with the repository's existing tsx toolchain
 * and an explicit candidate fixture directory:
 *
 *   node --import tsx benchmarks/autonomy/corpus/v1/autonomy-v1-007/assert.ts <candidate-fixture-dir>
 *
 * `<candidate-fixture-dir>` must be the candidate's fixture directory
 * containing `index.ts` and `tsconfig.json`. Candidate files are resolved
 * only from this argument — never from the frozen fixture in this case
 * directory or from an assumed working-tree location.
 *
 * Contract:
 * - stdout receives exactly one JSON array: one `{ assertionId, passed }`
 *   object per declared identifier, in declared order (`prefix-position`,
 *   `existing-strip-behavior`, `fixture-typecheck`). Nothing else is written
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
const ASSERTION_IDENTIFIERS = [
  "prefix-position",
  "existing-strip-behavior",
  "fixture-typecheck",
] as const;

type AssertionId = (typeof ASSERTION_IDENTIFIERS)[number];

interface AssertionOutcome {
  assertionId: AssertionId;
  passed: boolean;
}

/** Type of the candidate's exported `stripPrefix`, if the import succeeded. */
type StripPrefixFunction = (value: string, prefix: string) => string;

const caseDirectory = path.dirname(fileURLToPath(import.meta.url));

/**
 * Repository root, resolved relative to this assertion script (five
 * directory levels up from the case directory).
 */
const repositoryRoot = path.join(caseDirectory, "..", "..", "..", "..", "..");

function diagnostic(message: string): void {
  process.stderr.write(`[autonomy-v1-007 assert] ${message}\n`);
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
 * directory and return its exported `stripPrefix`, or `undefined` (with a
 * stderr diagnostic) when the candidate cannot be loaded or does not export
 * the expected function.
 */
async function importCandidateStripPrefix(candidateDir: string): Promise<StripPrefixFunction | undefined> {
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
  const exported = (module as Record<string, unknown>).stripPrefix;
  if (typeof exported !== "function") {
    diagnostic("candidate fixture does not export a `stripPrefix` function");
    return undefined;
  }
  return exported as StripPrefixFunction;
}

/**
 * One strict string-equality expectation for `stripPrefix`: the call
 * `stripPrefix(value, prefix)` must return exactly `expected`.
 */
interface StripExpectation {
  value: string;
  prefix: string;
  expected: string;
}

function runExpectations(
  stripPrefix: StripPrefixFunction,
  expectations: readonly StripExpectation[],
  assertionId: AssertionId,
): boolean {
  let allPass = true;
  for (const { value, prefix, expected } of expectations) {
    let result: unknown;
    try {
      result = stripPrefix(value, prefix);
    } catch (error) {
      diagnostic(
        `${assertionId}: stripPrefix(${describeValue(value)}, ${describeValue(prefix)}) threw: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    if (result !== expected) {
      diagnostic(
        `${assertionId}: stripPrefix(${describeValue(value)}, ${describeValue(prefix)}) returned ${describeValue(result)}; expected ${describeValue(expected)}`,
      );
      allPass = false;
    }
  }
  return allPass;
}

/**
 * `prefix-position`: the requested bug fix must be present — only a
 * *leading* occurrence of `prefix` is removed. An interior occurrence
 * (`'valuepre'`), an occurrence preceded by other text (`'xprevalue'`), a
 * case-mismatched leading occurrence (`'Prevalue'`), and a leading
 * occurrence preceded by a space (`' prevalue'`) must all be left
 * unchanged, checked with strict string equality.
 */
function checkPrefixPosition(stripPrefix: StripPrefixFunction): boolean {
  return runExpectations(
    stripPrefix,
    [
      { value: "valuepre", prefix: "pre", expected: "valuepre" },
      { value: "xprevalue", prefix: "pre", expected: "xprevalue" },
      { value: "Prevalue", prefix: "pre", expected: "Prevalue" },
      { value: " prevalue", prefix: "pre", expected: " prevalue" },
    ],
    "prefix-position",
  );
}

/**
 * `existing-strip-behavior`: the pristine behavior must be preserved —
 * a leading prefix is removed exactly once (`'prevalue'` → `'value'`), a
 * repeated leading prefix loses only the first occurrence
 * (`'preprevalue'` → `'prevalue'`), an absent prefix leaves the input
 * unchanged (`'value'` → `'value'`), an empty prefix leaves the input
 * unchanged (`'value'` → `'value'`), and an empty value stays empty
 * (`''` → `''`), all checked with strict string equality.
 *
 * The regression examples then pin the exact-matching contract that must
 * hold for both the pristine and a corrected implementation: literal
 * matching with no trimming or normalization of either argument (a
 * trailing space in the value survives the strip, a leading space in the
 * prefix does not match, a single-character prefix matches only a literal
 * leading dot, case sensitivity is preserved), and no Unicode
 * normalization (a composed `é` value is untouched by a decomposed
 * `e` + combining-acute prefix).
 */
function checkExistingStripBehavior(stripPrefix: StripPrefixFunction): boolean {
  const expectations: readonly StripExpectation[] = [
    // Existing leading-strip behavior.
    { value: "prevalue", prefix: "pre", expected: "value" },
    { value: "preprevalue", prefix: "pre", expected: "prevalue" },
    { value: "value", prefix: "pre", expected: "value" },
    { value: "value", prefix: "", expected: "value" },
    { value: "", prefix: "pre", expected: "" },
    // Regression examples: literal matching, no argument normalization.
    { value: "prevalue ", prefix: "pre", expected: "value " },
    { value: "prevalue", prefix: " pre", expected: "prevalue" },
    { value: ".value", prefix: ".", expected: "value" },
    { value: "Prevalue", prefix: "pre", expected: "Prevalue" },
    // Composed U+00E9 vs decomposed 'e' + U+0301: no normalization.
    { value: "évalue", prefix: "e\u0301", expected: "évalue" },
  ];
  return runExpectations(stripPrefix, expectations, "existing-strip-behavior");
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
  const stripPrefix = await importCandidateStripPrefix(candidateDir);
  if (stripPrefix === undefined) {
    // A candidate that cannot be loaded cannot evidence either behavioral
    // assertion; both are reported as failed, not missing.
    outcomes.set("prefix-position", false);
    outcomes.set("existing-strip-behavior", false);
  } else {
    outcomes.set("prefix-position", checkPrefixPosition(stripPrefix));
    outcomes.set("existing-strip-behavior", checkExistingStripBehavior(stripPrefix));
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
