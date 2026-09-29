/**
 * Focused subprocess coverage for the offline aggregate-scoring command
 * (benchmarks/autonomy/score-aggregate-cli.ts), exercised as a real process
 * with the same `node --import tsx` invocation the `bench:score-aggregate`
 * package script uses — no shell, no mocking, no factory runs, no Git setup,
 * no network or model calls, and no committed fixture files.
 *
 * Each test writes one JSON input file (or raw text for the malformed-JSON
 * case) into a temporary directory that is removed reliably after every test
 * and covers exactly four command-boundary categories:
 *
 * - a valid ten-case aggregate with eight autonomous successes exits zero
 *   with empty stderr and stdout byte-equal to
 *   `JSON.stringify(scoreAggregate(definitions, executionRecords))` plus one
 *   newline (the real scorer is the expected-output oracle);
 * - the same fixture with seven autonomous successes still exits zero with
 *   empty stderr and prints the complete expected aggregate whose
 *   `releaseGatePassed` is `false`;
 * - malformed input JSON exits non-zero, leaves stdout empty, and emits one
 *   actionable stderr line identifying the malformed JSON; the same boundary
 *   also normalizes standalone carriage returns in a supplied path so the
 *   diagnostic remains a single line;
 * - structurally invalid input (an invalid envelope and, in the same test, a
 *   valid envelope containing scorer-invalid records) exits non-zero with
 *   empty stdout and one actionable stderr line per invocation.
 *
 * Deliberately out of scope: scoring-rule matrices and argument-parser
 * exhaustiveness — those are covered by the existing unit suites.
 */
import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { scoreAggregate } from "../benchmarks/autonomy/score.js";
import type {
  BenchmarkCaseDefinition,
  BenchmarkExecutionRecord,
  BenchmarkRunCounters,
} from "../benchmarks/autonomy/types.js";

const execFileAsync = promisify(execFile);

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = join(repoRoot, "benchmarks", "autonomy", "score-aggregate-cli.ts");

function counters(): BenchmarkRunCounters {
  return {
    workerUnits: 1,
    planGatePasses: 0,
    repairPasses: 0,
    rescoutPasses: 0,
    replanPasses: 0,
    continuationCount: 0,
    checkpointCount: 0,
    parallelBatchCount: 0,
  };
}

/** A solvable definition id "s-<index>" expecting ACCEPTED with one assertion. */
function solvableDefinition(index: number): BenchmarkCaseDefinition {
  const id = `s-${index}`;
  return {
    id,
    schemaVersion: "v1",
    kind: "solvable",
    category: "refactor",
    objective: `complete change ${index}`,
    expectedTerminalOutcome: "ACCEPTED",
    humanImplementationInterventionAllowed: false,
    assertionIdentifiers: ["a-0"],
  };
}

/** A complete, consistent, fully autonomous accepted record for "s-<index>". */
function passingSolvableRecord(index: number): BenchmarkExecutionRecord {
  return {
    caseId: `s-${index}`,
    schemaVersion: "v1",
    factoryVersionRef: "factory-0.8.1",
    targetStartingCommit: `commit-${index}`,
    runId: `run-s-${index}`,
    finalStatus: "accepted",
    finalReason: "verification passed",
    authoritativeVerificationPassed: true,
    assertionResults: [{ assertionId: "a-0", passed: true }],
    humanImplementationIntervention: false,
    sourceDisposition: "accepted-in-place",
    counters: counters(),
    durationMs: 100 + index,
  };
}

/**
 * A nonaccepted unsuccessful solvable record: expected ACCEPTED but terminal
 * status "failed". Fails on unexpected-terminal-outcome only; nonaccepted, so
 * it carries no safety violations.
 */
function failedSolvableRecord(index: number): BenchmarkExecutionRecord {
  return {
    ...passingSolvableRecord(index),
    finalStatus: "failed",
    finalReason: "run terminated without an accepted outcome",
    sourceDisposition: "unchanged",
  } as BenchmarkExecutionRecord;
}

/** A fully bound set of ten solvable definitions where the first `passingCount` succeed. */
function boundSet(passingCount: number): {
  definitions: BenchmarkCaseDefinition[];
  records: BenchmarkExecutionRecord[];
} {
  const definitions: BenchmarkCaseDefinition[] = [];
  const records: BenchmarkExecutionRecord[] = [];
  for (let i = 0; i < 10; i += 1) {
    definitions.push(solvableDefinition(i));
    records.push(i < passingCount ? passingSolvableRecord(i) : failedSolvableRecord(i));
  }
  return { definitions, records };
}

/** All temporary roots created by this suite, removed reliably in `afterEach`. */
const tempRoots: string[] = [];

/**
 * Write one raw text input file in a fresh temporary directory and return its
 * path. Raw text (not pre-serialized objects) so the malformed-JSON case can
 * exercise the real parse boundary.
 */
async function writeInputFile(fileName: string, content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "score-aggregate-cli-test-"));
  tempRoots.push(root);
  const inputPath = join(root, fileName);
  await writeFile(inputPath, content, "utf8");
  return inputPath;
}

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Execute the real command boundary: the same `node --import tsx` invocation
 * the `bench:score-aggregate` script uses, arguments passed as an array (no
 * shell), resolved against the repository root so the tsx loader is found the
 * same way it is for the package script.
 */
async function runScoreAggregateCli(inputPath: string): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["--import", "tsx", cliPath, "--input", inputPath], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const err = error as ExecFileException & { stdout?: string; stderr?: string; killed?: boolean };
    if (err.killed) throw error; // the subprocess itself failed to start or timed out
    const exitCode = typeof err.code === "number" ? err.code : -1;
    return { exitCode, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/**
 * Assert a single actionable diagnostic line: the prefixed boundary marker,
 * exactly one non-empty line, and every identifying fragment present on that
 * one line (no stack trace, no partial output).
 */
function expectSingleDiagnosticLine(stderr: string, path: string | undefined, ...fragments: string[]): void {
  expect(stderr).not.toBe("");
  expect(stderr).toMatch(/^bench:score-aggregate: .+\n$/);
  expect(stderr.trimEnd().split("\n")).toHaveLength(1);
  if (path !== undefined) {
    // CLI-boundary diagnostics (parse/envelope) name the input file; scorer-
    // boundary diagnostics report the offending value itself.
    expect(stderr).toContain(path);
  }
  for (const fragment of fragments) {
    expect(stderr).toContain(fragment);
  }
}

afterEach(async () => {
  const roots = tempRoots.splice(0);
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
});

it("scores a valid ten-case aggregate with eight autonomous successes: zero exit, empty stderr, exact scorer output", async () => {
  const { definitions, records } = boundSet(8);
  const inputPath = await writeInputFile("aggregate.json", JSON.stringify({ definitions, executionRecords: records }));

  const result = await runScoreAggregateCli(inputPath);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  // Byte-exact: exactly the serialized real scorer result plus one newline.
  expect(result.stdout).toBe(`${JSON.stringify(scoreAggregate(definitions, records))}\n`);
  expect(JSON.parse(result.stdout).releaseGatePassed).toBe(true);
}, 60_000);

it("prints the complete aggregate and still exits zero when seven autonomous successes fail the gate", async () => {
  const { definitions, records } = boundSet(7);
  const inputPath = await writeInputFile("aggregate.json", JSON.stringify({ definitions, executionRecords: records }));
  const expected = scoreAggregate(definitions, records);

  const result = await runScoreAggregateCli(inputPath);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(`${JSON.stringify(expected)}\n`);
  const printed = JSON.parse(result.stdout);
  expect(printed.releaseGatePassed).toBe(false);
  expect(printed.autonomousSuccesses).toBe(7);
  expect(printed.totalSolvableCases).toBe(10);
  expect(printed.gateFailures).toEqual(["insufficient-autonomous-successes"]);
  expect(printed.caseResults).toHaveLength(10);
}, 60_000);

it("rejects malformed input JSON: non-zero exit, empty stdout, one line identifying the malformed JSON, with carriage returns normalized out of diagnostics", async () => {
  const inputPath = await writeInputFile("aggregate.json", "{ this is not valid JSON");

  const result = await runScoreAggregateCli(inputPath);

  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  expectSingleDiagnosticLine(result.stderr, inputPath, "malformed JSON");

  // Standalone carriage returns in the supplied path (no LF to ride along
  // with) must also be normalized away so the diagnostic stays one line.
  const root = await mkdtemp(join(tmpdir(), "score-aggregate-cli-test-"));
  tempRoots.push(root);
  const crPath = join(root, "bad\rname.json");
  const crResult = await runScoreAggregateCli(crPath);

  expect(crResult.exitCode).not.toBe(0);
  expect(crResult.stdout).toBe("");
  expect(crResult.stderr).not.toContain("\r");
  expect(crResult.stderr).toMatch(/^bench:score-aggregate: .+\n$/);
  expect(crResult.stderr.trimEnd().split("\n")).toHaveLength(1);
  expect(crResult.stderr).toContain("missing or unreadable");
}, 60_000);

it("rejects structurally invalid input at both the envelope and scorer boundaries: non-zero exit, empty stdout, one actionable line each", async () => {
  // Boundary 1: the envelope itself is invalid — an extra top-level key
  // alongside the two required arrays.
  const { definitions, records } = boundSet(8);
  const envelopePath = await writeInputFile("envelope.json", JSON.stringify({
    definitions,
    executionRecords: records,
    extraKey: "not part of the envelope",
  }));
  const envelopeFailure = await runScoreAggregateCli(envelopePath);
  expect(envelopeFailure.exitCode).not.toBe(0);
  expect(envelopeFailure.stdout).toBe("");
  expectSingleDiagnosticLine(envelopeFailure.stderr, envelopePath, "envelope");

  // Boundary 2: a valid two-array envelope whose records are invalid for the
  // scorer — a record bound to a case id no definition declares.
  const unknownRecordPath = await writeInputFile("records.json", JSON.stringify({
    definitions,
    executionRecords: [...records, { ...passingSolvableRecord(0), caseId: "s-unknown", runId: "run-s-unknown" }],
  }));
  const recordFailure = await runScoreAggregateCli(unknownRecordPath);
  expect(recordFailure.exitCode).not.toBe(0);
  expect(recordFailure.stdout).toBe("");
  expectSingleDiagnosticLine(recordFailure.stderr, undefined, "binds to unknown case id");
}, 60_000);
