/**
 * autonomy-v1-008 local assertion script: deterministic checks for the
 * reversed object-merge precedence `mergeOptions` bug-fix case.
 *
 * This is a standalone, manually invoked case-specific test script — not a
 * runner abstraction. Invoke it with the repository's existing tsx toolchain
 * and an explicit candidate fixture directory:
 *
 *   node --import tsx benchmarks/autonomy/corpus/v1/autonomy-v1-008/assert.ts <candidate-fixture-dir>
 *
 * `<candidate-fixture-dir>` must be the candidate's fixture directory
 * containing `index.ts` and `tsconfig.json`. Candidate files are resolved
 * only from this argument — never from the frozen fixture in this case
 * directory or from an assumed working-tree location.
 *
 * Contract:
 * - stdout receives exactly one JSON array: one `{ assertionId, passed }`
 *   object per declared identifier, in declared order (`override-precedence`,
 *   `existing-merge-behavior`, `fixture-typecheck`). Nothing else is written
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
  "override-precedence",
  "existing-merge-behavior",
  "fixture-typecheck",
] as const;

type AssertionId = (typeof ASSERTION_IDENTIFIERS)[number];

interface AssertionOutcome {
  assertionId: AssertionId;
  passed: boolean;
}

/** Type of the candidate's exported `mergeOptions`, if the import succeeded. */
type MergeOptionsFunction = (
  defaults: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, string>>,
) => Record<string, string>;

const caseDirectory = path.dirname(fileURLToPath(import.meta.url));

/**
 * Repository root, resolved relative to this assertion script (five
 * directory levels up from the case directory).
 */
const repositoryRoot = path.join(caseDirectory, "..", "..", "..", "..", "..");

function diagnostic(message: string): void {
  process.stderr.write(`[autonomy-v1-008 assert] ${message}\n`);
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
 * directory and return its exported `mergeOptions`, or `undefined` (with a
 * stderr diagnostic) when the candidate cannot be loaded or does not export
 * the expected function.
 */
async function importCandidateMergeOptions(candidateDir: string): Promise<MergeOptionsFunction | undefined> {
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
  const exported = (module as Record<string, unknown>).mergeOptions;
  if (typeof exported !== "function") {
    diagnostic("candidate fixture does not export a `mergeOptions` function");
    return undefined;
  }
  return exported as MergeOptionsFunction;
}

/**
 * One `override-precedence` expectation: `mergeOptions(defaults, overrides)`
 * must deep-equal `expected`. For keys present in both inputs the override
 * value wins; keys present in only one input survive.
 */
interface PrecedenceExpectation {
  defaults: Record<string, string>;
  overrides: Record<string, string>;
  expected: Record<string, string>;
}

/**
 * `override-precedence`: the requested bug fix must be present — for every
 * key present in both inputs the value from `overrides` wins, including an
 * empty-string override value winning over a nonempty default, while keys
 * present in only one input survive with their original values. Compared
 * with `isDeepStrictEqual`, not JSON serialization or object identity.
 */
function checkOverridePrecedence(mergeOptions: MergeOptionsFunction): boolean {
  const expectations: readonly PrecedenceExpectation[] = [
    {
      defaults: { host: "localhost", mode: "safe" },
      overrides: { mode: "fast" },
      expected: { host: "localhost", mode: "fast" },
    },
    {
      defaults: { mode: "safe", Mode: "upper" },
      overrides: { mode: "fast" },
      expected: { mode: "fast", Mode: "upper" },
    },
    {
      defaults: { mode: "safe" },
      overrides: { mode: "" },
      expected: { mode: "" },
    },
  ];
  let allPass = true;
  for (const { defaults, overrides, expected } of expectations) {
    const defaultsText = describeValue(defaults);
    const overridesText = describeValue(overrides);
    let result: unknown;
    try {
      result = mergeOptions(defaults, overrides);
    } catch (error) {
      diagnostic(
        `override-precedence: mergeOptions(${defaultsText}, ${overridesText}) threw: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    if (!isDeepStrictEqual(result, expected)) {
      diagnostic(
        `override-precedence: mergeOptions(${defaultsText}, ${overridesText}) returned ${describeValue(result)}; expected ${describeValue(expected)}`,
      );
      allPass = false;
    }
  }
  return allPass;
}

/**
 * One `existing-merge-behavior` expectation: `mergeOptions(defaults,
 * overrides)` must deep-equal `expected`. These cases deliberately contain
 * no conflicting keys, so they hold for both the pristine and a corrected
 * implementation.
 */
interface MergeBehaviorExpectation {
  defaults: Record<string, string>;
  overrides: Record<string, string>;
  expected: Record<string, string>;
}

/**
 * One conflicting-key `existing-merge-behavior` expectation: both inputs
 * share at least one exact key. This expectation deliberately does not
 * assert which conflicting value wins — that is the
 * `override-precedence` assertion's job — so it holds for both the pristine
 * (defaults-wins) and a corrected (overrides-wins) implementation. It
 * asserts that neither input is mutated, that the result is a fresh object
 * distinct from both inputs, and that keys present in only one input
 * survive with their original values.
 */
interface ConflictMergeBehaviorExpectation {
  defaults: Record<string, string>;
  overrides: Record<string, string>;
  /** Keys present in only one input, which must survive with their original values. */
  preserved: Record<string, string>;
}

/**
 * For one `mergeOptions` invocation, verify that neither input changed
 * (each compared against an independent pre-call snapshot) and that the
 * result is a fresh object distinct from both inputs. Returns `true` when
 * both properties hold; otherwise writes a diagnostic and returns `false`.
 */
function verifyInputsUntouchedAndResultFresh(
  defaults: Record<string, string>,
  overrides: Record<string, string>,
  defaultsBefore: Record<string, string>,
  overridesBefore: Record<string, string>,
  result: unknown,
): boolean {
  let ok = true;
  if (!isDeepStrictEqual(defaults, defaultsBefore) || !isDeepStrictEqual(overrides, overridesBefore)) {
    diagnostic(
      `existing-merge-behavior: mergeOptions(${describeValue(defaults)}, ${describeValue(overrides)}) mutated an input: defaults=${describeValue(defaults)}, overrides=${describeValue(overrides)}`,
    );
    ok = false;
  }
  if (result === defaults || result === overrides) {
    diagnostic(
      `existing-merge-behavior: mergeOptions(${describeValue(defaults)}, ${describeValue(overrides)}) returned one of its input objects instead of a fresh object`,
    );
    ok = false;
  }
  return ok;
}

/**
 * `existing-merge-behavior`: the pristine behavior must be preserved —
 * empty inputs yield an empty result, defaults-only keys survive,
 * overrides-only keys survive, multiple non-conflicting keys from both
 * inputs all survive, case-sensitive keys stay distinct (`theme` and
 * `Theme` coexist), and — on a call where both inputs share an exact key —
 * neither input is mutated while keys unique to each input survive, without
 * asserting which conflicting value wins. In every case both inputs are
 * compared against independent pre-call snapshots (no mutation), and the
 * result is verified to be a fresh object distinct from both inputs,
 * including the empty-input behavior. All value comparisons use
 * `isDeepStrictEqual`.
 */
function checkExistingMergeBehavior(mergeOptions: MergeOptionsFunction): boolean {
  const expectations: readonly MergeBehaviorExpectation[] = [
    // Empty inputs produce an empty result.
    { defaults: {}, overrides: {}, expected: {} },
    // Defaults-only keys survive with their original values.
    { defaults: { a: "1", b: "2" }, overrides: {}, expected: { a: "1", b: "2" } },
    // Overrides-only keys survive with their original values.
    { defaults: {}, overrides: { c: "3", d: "4" }, expected: { c: "3", d: "4" } },
    // Multiple non-conflicting keys from both inputs all survive.
    {
      defaults: { a: "1", c: "3" },
      overrides: { b: "2", d: "4" },
      expected: { a: "1", b: "2", c: "3", d: "4" },
    },
    // Key matching is exact and case-sensitive: `theme` and `Theme` are
    // distinct keys that both survive.
    {
      defaults: { theme: "dark" },
      overrides: { Theme: "light" },
      expected: { theme: "dark", Theme: "light" },
    },
  ];
  let allPass = true;
  for (const { defaults, overrides, expected } of expectations) {
    const defaultsText = describeValue(defaults);
    const overridesText = describeValue(overrides);
    // Independent pre-call snapshots: the inputs must be unchanged after the
    // call, in every case including the empty-input case.
    const defaultsBefore: Record<string, string> = { ...defaults };
    const overridesBefore: Record<string, string> = { ...overrides };
    let result: unknown;
    try {
      result = mergeOptions(defaults, overrides);
    } catch (error) {
      diagnostic(
        `existing-merge-behavior: mergeOptions(${defaultsText}, ${overridesText}) threw: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    if (!verifyInputsUntouchedAndResultFresh(defaults, overrides, defaultsBefore, overridesBefore, result)) {
      allPass = false;
      continue;
    }
    if (!isDeepStrictEqual(result, expected)) {
      diagnostic(
        `existing-merge-behavior: mergeOptions(${defaultsText}, ${overridesText}) returned ${describeValue(result)}; expected ${describeValue(expected)}`,
      );
      allPass = false;
    }
  }
  // Conflicting key: both inputs share the exact key `shared`. This
  // expectation pins the frozen non-mutation requirement exactly where a
  // candidate is most likely to violate it — while resolving the
  // conflicting key — without asserting which conflicting value wins, so
  // both the pristine and a corrected implementation satisfy it.
  const conflict: ConflictMergeBehaviorExpectation = {
    defaults: { a: "1", shared: "default" },
    overrides: { shared: "override", b: "2" },
    preserved: { a: "1", b: "2" },
  };
  const conflictDefaultsBefore: Record<string, string> = { ...conflict.defaults };
  const conflictOverridesBefore: Record<string, string> = { ...conflict.overrides };
  let conflictResult: unknown;
  try {
    conflictResult = mergeOptions(conflict.defaults, conflict.overrides);
  } catch (error) {
    diagnostic(
      `existing-merge-behavior: mergeOptions(${describeValue(conflict.defaults)}, ${describeValue(conflict.overrides)}) threw: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
  if (!verifyInputsUntouchedAndResultFresh(conflict.defaults, conflict.overrides, conflictDefaultsBefore, conflictOverridesBefore, conflictResult)) {
    allPass = false;
  } else if (typeof conflictResult !== "object" || conflictResult === null) {
    diagnostic(
      `existing-merge-behavior: mergeOptions(${describeValue(conflict.defaults)}, ${describeValue(conflict.overrides)}) did not return an object: ${describeValue(conflictResult)}`,
    );
    allPass = false;
  } else {
    const resultRecord = conflictResult as Record<string, string>;
    for (const [key, value] of Object.entries(conflict.preserved)) {
      if (!Object.hasOwn(resultRecord, key) || !isDeepStrictEqual(resultRecord[key], value)) {
        diagnostic(
          `existing-merge-behavior: mergeOptions(${describeValue(conflict.defaults)}, ${describeValue(conflict.overrides)}) did not preserve unique key ${key}=${JSON.stringify(value)}; returned ${describeValue(conflictResult)}`,
        );
        allPass = false;
        break;
      }
    }
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
  const mergeOptions = await importCandidateMergeOptions(candidateDir);
  if (mergeOptions === undefined) {
    // A candidate that cannot be loaded cannot evidence either behavioral
    // assertion; both are reported as failed, not missing.
    outcomes.set("override-precedence", false);
    outcomes.set("existing-merge-behavior", false);
  } else {
    outcomes.set("override-precedence", checkOverridePrecedence(mergeOptions));
    outcomes.set("existing-merge-behavior", checkExistingMergeBehavior(mergeOptions));
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
