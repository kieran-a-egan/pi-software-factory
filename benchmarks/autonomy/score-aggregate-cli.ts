/**
 * Offline CLI that scores a benchmark aggregate from one explicit JSON file.
 *
 * The command reads only the caller-supplied input file, delegates all
 * validation and scoring to the existing deterministic
 * {@link scoreAggregate}, and prints exactly one serialized
 * {@link BenchmarkAggregateScore} JSON value plus a newline to stdout:
 *
 *   1. parses the CLI flags (exactly one `--input <file>`; nothing else);
 *   2. reads the file as UTF-8 and JSON-parses it;
 *   3. rejects anything other than the exact envelope: a non-null,
 *      non-array object with exactly the `definitions` and `executionRecords`
 *      keys, both arrays. Array-element validation and definition/record
 *      binding semantics are delegated entirely to {@link scoreAggregate};
 *   4. scores the parsed arrays directly, without modification.
 *
 * Usage (`npm run --silent ... --` suppresses npm's own script banner for
 * machine-readable stdout):
 *
 *   npm run --silent bench:score-aggregate -- --input ./aggregate.json
 *
 * Input file shape (exact envelope; no other keys, no other top-level forms):
 *
 *   {
 *     "definitions": [ /* BenchmarkCaseDefinition objects *\/ ],
 *     "executionRecords": [ /* BenchmarkExecutionRecord objects *\/ ]
 *   }
 *
 * A successfully computed aggregate with `releaseGatePassed: false` is still
 * a successful command (exit code zero). Argument, file-read, JSON parse,
 * envelope, and scoring errors print one concise prefixed line to stderr
 * (no stack trace), leave stdout empty, and set the exit code to 1. The
 * command performs no execution, discovery, Git/GitHub operations, network
 * access, model calls, or production factory invocation.
 */
import { readFile } from "node:fs/promises";

import { scoreAggregate } from "./score.js";

const USAGE =
  "Usage:\n" +
  "  npm run --silent bench:score-aggregate -- --input <file>  (JSON: {\"definitions\": [...], \"executionRecords\": [...]})";

/**
 * Exact top-level envelope accepted from the input file: exactly the
 * `definitions` and `executionRecords` keys, both arrays.
 */
interface AggregateInputEnvelope {
  definitions: unknown[];
  executionRecords: unknown[];
}

/**
 * Strictly parse the CLI flags: exactly one `--input` flag with one file
 * value. Duplicates, unknown options, positional arguments, missing values,
 * and alternate spellings are errors. No defaults, stdin, or discovery.
 */
function parseArgs(argv: string[]): string {
  let inputPath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token !== "--input") {
      const kind = token.startsWith("--") ? "unknown option" : "unexpected positional argument";
      throw new Error(`${kind} ${JSON.stringify(token)}; ${USAGE}`);
    }
    if (inputPath !== undefined) {
      throw new Error(`duplicate option --input; ${USAGE}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --input; ${USAGE}`);
    }
    inputPath = value;
    i += 1;
  }
  if (inputPath === undefined) {
    throw new Error(`missing required flag: --input; ${USAGE}`);
  }
  return inputPath;
}

/**
 * Validate the parsed JSON value against the exact two-array envelope.
 * Element-level validation is delegated to {@link scoreAggregate}.
 */
function parseEnvelope(parsed: unknown, inputPath: string): AggregateInputEnvelope {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const shape = Array.isArray(parsed) ? "an array" : `a ${describeJsonType(parsed)} value`;
    throw new Error(`input file ${inputPath}: expected the exact envelope {"definitions": [...], "executionRecords": [...]}, got ${shape}`);
  }
  const keys = Object.keys(parsed as Record<string, unknown>);
  if (keys.length !== 2 || !keys.includes("definitions") || !keys.includes("executionRecords")) {
    throw new Error(
      `input file ${inputPath}: envelope must have exactly the keys "definitions" and "executionRecords", got keys [${keys.map((k) => JSON.stringify(k)).join(", ")}]`,
    );
  }
  const definitions = (parsed as Record<string, unknown>).definitions;
  const executionRecords = (parsed as Record<string, unknown>).executionRecords;
  if (!Array.isArray(definitions)) {
    throw new Error(`input file ${inputPath}: "definitions" must be an array, got ${describeJsonType(definitions)}`);
  }
  if (!Array.isArray(executionRecords)) {
    throw new Error(`input file ${inputPath}: "executionRecords" must be an array, got ${describeJsonType(executionRecords)}`);
  }
  return { definitions, executionRecords };
}

function describeJsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Read the caller-supplied input file as UTF-8 and parse it as JSON,
 * contextualizing read and parse failures separately with the file path.
 */
async function readJsonFile(inputPath: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(inputPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const detail = code ?? (error instanceof Error ? error.message : String(error));
    throw new Error(`input file ${inputPath}: missing or unreadable (${detail})`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`input file ${inputPath}: malformed JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

function main(): void {
  let inputPath: string;
  try {
    inputPath = parseArgs(process.argv.slice(2));
  } catch (error) {
    reportError(error);
    return;
  }
  void (async () => {
    try {
      const parsed = await readJsonFile(inputPath);
      const envelope = parseEnvelope(parsed, inputPath);
      const result = scoreAggregate(envelope.definitions, envelope.executionRecords);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      reportError(error);
    }
  })();
}

/**
 * Command-boundary error reporting: one concise prefixed line on stderr
 * (embedded line breaks normalized away to keep the diagnostic on one line),
 * no stack trace, and a non-zero exit code.
 */
function reportError(error: unknown): void {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s*[\r\n\u2028\u2029]\s*/g, " ");
  process.stderr.write(`bench:score-aggregate: ${message}\n`);
  process.exitCode = 1;
}

main();
