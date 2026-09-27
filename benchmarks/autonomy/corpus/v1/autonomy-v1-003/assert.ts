/**
 * autonomy-v1-003 local assertion script: deterministic checks for the
 * zero-port-rejected input-validation boundary-bug case.
 *
 * This is a standalone, manually invoked case-specific test script — not a
 * runner abstraction. Invoke it with the repository's existing tsx toolchain
 * and an explicit candidate fixture directory:
 *
 *   node --import tsx benchmarks/autonomy/corpus/v1/autonomy-v1-003/assert.ts <candidate-fixture-dir>
 *
 * `<candidate-fixture-dir>` must be the candidate's fixture directory
 * containing `index.ts` and `tsconfig.json`. Candidate files are resolved
 * only from this argument — never from the frozen fixture in this case
 * directory or from an assumed working-tree location.
 *
 * Contract:
 * - stdout receives exactly one JSON array: one `{ assertionId, passed }`
 *   object per declared identifier, in declared order (`zero-port-rejected`,
 *   `existing-port-behavior`, `fixture-typecheck`). Nothing else is written
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
const ASSERTION_IDENTIFIERS = ["zero-port-rejected", "existing-port-behavior", "fixture-typecheck"] as const;

type AssertionId = (typeof ASSERTION_IDENTIFIERS)[number];

interface AssertionOutcome {
  assertionId: AssertionId;
  passed: boolean;
}

/** Type of the candidate's exported `parsePort`, if the import succeeded. */
type ParsePortFunction = (value: string) => number | undefined;

const caseDirectory = path.dirname(fileURLToPath(import.meta.url));

/**
 * Repository root, resolved relative to this assertion script (five
 * directory levels up from the case directory).
 */
const repositoryRoot = path.join(caseDirectory, "..", "..", "..", "..", "..");

function diagnostic(message: string): void {
  process.stderr.write(`[autonomy-v1-003 assert] ${message}\n`);
}

/**
 * Dynamically import the candidate fixture from the explicit candidate
 * directory and return its exported `parsePort`, or `undefined` (with a
 * stderr diagnostic) when the candidate cannot be loaded or does not export
 * the expected function.
 */
async function importCandidateParsePort(candidateDir: string): Promise<ParsePortFunction | undefined> {
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
  const exported = (module as Record<string, unknown>).parsePort;
  if (typeof exported !== "function") {
    diagnostic("candidate fixture does not export a `parsePort` function");
    return undefined;
  }
  return exported as ParsePortFunction;
}

/** Strictly compare an actual `number | undefined` against an expected value. */
function matches(actual: number | undefined, expected: number | undefined): boolean {
  return actual === expected;
}

/**
 * `zero-port-rejected`: the requested boundary-bug repair must be present —
 * `parsePort("0")` must return `undefined`, checked with strict equality.
 */
function checkZeroPortRejected(parsePort: ParsePortFunction): boolean {
  let result: number | undefined;
  try {
    result = parsePort("0");
  } catch (error) {
    diagnostic(`parsePort("0") threw: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (result !== undefined) {
    diagnostic(`parsePort("0") returned ${String(result)}; expected undefined`);
    return false;
  }
  return true;
}

/**
 * `existing-port-behavior`: the pristine behavior must be preserved —
 * '1', '80', '443', '3000', and '65535' return their exact decimal values;
 * '65536' (above the upper bound), '-1' (negative), '1.5' (non-integer),
 * ' 80' and '80 ' (surrounding whitespace), the empty string, and
 * nonnumeric strings all return undefined.
 */
function checkExistingPortBehavior(parsePort: ParsePortFunction): boolean {
  const expectations: ReadonlyArray<{ value: string; expected: number | undefined }> = [
    { value: "1", expected: 1 },
    { value: "80", expected: 80 },
    { value: "443", expected: 443 },
    { value: "3000", expected: 3000 },
    { value: "65535", expected: 65535 },
    { value: "65536", expected: undefined },
    { value: "-1", expected: undefined },
    { value: "1.5", expected: undefined },
    { value: " 80", expected: undefined },
    { value: "80 ", expected: undefined },
    { value: "", expected: undefined },
    { value: "abc", expected: undefined },
    { value: "8a0", expected: undefined },
    { value: "1e2", expected: undefined },
    { value: "+80", expected: undefined },
  ];
  let allPass = true;
  for (const { value, expected } of expectations) {
    let result: number | undefined;
    try {
      result = parsePort(value);
    } catch (error) {
      diagnostic(`parsePort(${JSON.stringify(value)}) threw: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (!matches(result, expected)) {
      diagnostic(`parsePort(${JSON.stringify(value)}) returned ${String(result)}; expected ${String(expected)}`);
      allPass = false;
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
  const parsePort = await importCandidateParsePort(candidateDir);
  if (parsePort === undefined) {
    // A candidate that cannot be loaded cannot evidence either behavioral
    // assertion; both are reported as failed, not missing.
    outcomes.set("zero-port-rejected", false);
    outcomes.set("existing-port-behavior", false);
  } else {
    outcomes.set("zero-port-rejected", checkZeroPortRejected(parsePort));
    outcomes.set("existing-port-behavior", checkExistingPortBehavior(parsePort));
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
