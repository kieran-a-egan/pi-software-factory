/**
 * Offline CLI that scores one explicitly supplied completed benchmark run.
 *
 * The command reads only the caller-supplied inputs, composes the existing
 * benchmark modules, and prints exactly one serialized
 * {@link BenchmarkCaseScore} JSON value plus a newline to stdout:
 *
 *   1. reads and JSON-parses the case definition file, then validates it with
 *      {@link validateBenchmarkCaseDefinition}; the validated `id` is used as
 *      the ingestion metadata `caseId` (caller input, never discovered);
 *   2. reads and JSON-parses the assertion results file (a top-level JSON
 *      array of `{ "assertionId": string, "passed": boolean }` objects);
 *      structure validation is delegated to the existing ingestion/record
 *      validation — nothing is filtered, coerced, or defaulted here;
 *   3. ingests the run directory with {@link ingestRunArtifacts} using the
 *      explicit metadata (case id, opaque factory version ref, strictly
 *      parsed intervention boolean, and the parsed assertion results);
 *   4. scores the validated definition and ingested record with
 *      {@link scoreCase}.
 *
 * Usage (all five flags are required; `npm run --silent ... --` suppresses
 * npm's own script banner for machine-readable stdout):
 *
 *   npm run --silent bench:score-case -- \
 *     --case-definition ./cases/case-001.json \
 *     --run-directory ./runs/<run-id> \
 *     --assertion-results ./assertions/case-001.json \
 *     --human-implementation-intervention false \
 *     --factory-version-ref pi-software-factory@0.8.1
 *
 * Assertion results file shape (top-level array, in the definition's
 * declaration order; missing declared assertions are permitted and reported
 * as incomplete evidence by the scorer):
 *
 *   [
 *     { "assertionId": "asserts-compile", "passed": true },
 *     { "assertionId": "tests-pass", "passed": true }
 *   ]
 *
 * A successfully computed score with `passed: false` is still a successful
 * command (exit code zero). Argument, filesystem, JSON parse, ingestion, and
 * scoring errors print one concise prefixed line to stderr (no stack trace),
 * leave stdout empty, and set the exit code to 1. The command performs no
 * execution, discovery, Git/GitHub operations, network access, model calls,
 * or production factory invocation.
 */
import { readFile } from "node:fs/promises";

import { ingestRunArtifacts } from "./run-artifacts.js";
import { scoreCase } from "./score.js";
import type { BenchmarkAssertionResult } from "./types.js";
import { validateBenchmarkCaseDefinition } from "./validate.js";

const FLAG_NAMES = [
  "--case-definition",
  "--run-directory",
  "--assertion-results",
  "--human-implementation-intervention",
  "--factory-version-ref",
] as const;

type FlagName = (typeof FLAG_NAMES)[number];

const USAGE = [
  "Usage:",
  "  npm run --silent bench:score-case --",
  "    --case-definition <file> \\  (JSON benchmark case definition)",
  "    --run-directory <directory> \\  (completed run directory)",
  "    --assertion-results <file> \\  (JSON array of {\"assertionId\", \"passed\"})",
  "    --human-implementation-intervention <true|false> \\  (exactly true or false)",
  "    --factory-version-ref <string>  (opaque factory provenance, passed unchanged)",
].join("\n");

interface ParsedArgs {
  caseDefinitionPath: string;
  runDirectory: string;
  assertionResultsPath: string;
  humanImplementationIntervention: boolean;
  factoryVersionRef: string;
}

/**
 * Strictly parse the CLI flags: exactly the five required flags, each with a
 * value, in any order. Unknown options, positional arguments, duplicate
 * options, missing values, and boolean spellings other than the exact
 * `true`/`false` strings are errors. Nothing is defaulted.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const values: Partial<Record<FlagName, string>> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!FLAG_NAMES.includes(token as FlagName)) {
      const kind = token.startsWith("--") ? "unknown option" : "unexpected positional argument";
      throw new Error(`${kind} ${JSON.stringify(token)}; ${USAGE}`);
    }
    const flag = token as FlagName;
    if (values[flag] !== undefined) {
      throw new Error(`duplicate option ${flag}; ${USAGE}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${flag}; ${USAGE}`);
    }
    if (flag === "--human-implementation-intervention" && value !== "true" && value !== "false") {
      throw new Error(
        `--human-implementation-intervention must be exactly true or false, got ${JSON.stringify(value)}; ${USAGE}`,
      );
    }
    values[flag] = value;
    i += 1;
  }
  const missing = FLAG_NAMES.filter((flag) => values[flag] === undefined);
  if (missing.length > 0) {
    throw new Error(`missing required flag(s): ${missing.join(", ")}; ${USAGE}`);
  }
  return {
    caseDefinitionPath: values["--case-definition"] as string,
    runDirectory: values["--run-directory"] as string,
    assertionResultsPath: values["--assertion-results"] as string,
    humanImplementationIntervention: (values["--human-implementation-intervention"] as string) === "true",
    factoryVersionRef: values["--factory-version-ref"] as string,
  };
}

/**
 * Read one caller-supplied input file and parse it as JSON, contextualizing
 * read/parse failures with the input role and path. The parsed value is
 * untrusted and is validated by the downstream benchmark modules.
 */
async function readJsonFile(filePath: string, role: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const detail = code ?? (error instanceof Error ? error.message : String(error));
    throw new Error(`${role} file ${filePath}: missing or unreadable (${detail})`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${role} file ${filePath}: malformed JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

function main(): void {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    reportError(error);
    return;
  }
  void (async () => {
    try {
      const parsedDefinition = await readJsonFile(args.caseDefinitionPath, "case definition");
      const definition = validateBenchmarkCaseDefinition(parsedDefinition);
      const assertionResults = await readJsonFile(args.assertionResultsPath, "assertion results");
      const record = await ingestRunArtifacts(args.runDirectory, {
        caseId: definition.id,
        factoryVersionRef: args.factoryVersionRef,
        humanImplementationIntervention: args.humanImplementationIntervention,
        // Structure validation is delegated to the existing record
        // validation inside ingestion; nothing is filtered or coerced here.
        assertionResults: assertionResults as ReadonlyArray<BenchmarkAssertionResult>,
      });
      const score = scoreCase(definition, record);
      process.stdout.write(`${JSON.stringify(score)}\n`);
    } catch (error) {
      reportError(error);
    }
  })();
}

/**
 * Command-boundary error reporting: one concise prefixed message on stderr,
 * no stack trace, and a non-zero exit code.
 */
function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`bench:score-case: ${message}\n`);
  process.exitCode = 1;
}

main();
