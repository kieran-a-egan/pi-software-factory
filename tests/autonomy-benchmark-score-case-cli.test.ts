/**
 * Focused subprocess coverage for the offline single-case scoring command
 * (benchmarks/autonomy/score-case-cli.ts), exercised as a real process with
 * the same `node --import tsx` invocation the `bench:score-case` package
 * script uses — no shell, no mocking, no factory runs, no Git setup, no
 * network or model calls, and no committed fixture files.
 *
 * Each test generates a minimal but internally consistent completed-run
 * fixture (the four required run artifacts, a valid case definition, and an
 * assertion-results file) inside temporary directories that are removed
 * reliably after every test, and covers only the requested command-boundary
 * categories:
 *
 * - a valid case scored twice with identical inputs exits zero with empty
 *   stderr and byte-identical stdout that parses to the expected successful
 *   {@link BenchmarkCaseScore};
 * - `--human-implementation-intervention` passes through unchanged: the same
 *   solvable accepted fixture scored with `true` yields the intervention
 *   failure reason and safety violation and flips `autonomousSuccess`, while
 *   both invocations exit zero with complete scores;
 * - a malformed case-definition file exits non-zero with empty stdout and a
 *   stderr diagnostic identifying the case-definition input;
 * - a malformed assertion-results file exits non-zero with empty stdout and a
 *   stderr diagnostic identifying the assertion-results input;
 * - missing run evidence (a nonexistent supplied run directory, and an
 *   otherwise valid directory missing one required artifact) exits non-zero
 *   with empty stdout and a diagnostic naming the missing location/artifact.
 *
 * Deliberately out of scope: scoring-rule matrices, ingestion internals, and
 * argument-parser exhaustiveness — those are covered by the existing unit
 * suites for the benchmark modules.
 */
import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = join(repoRoot, "benchmarks", "autonomy", "score-case-cli.ts");

const CASE_ID = "case-sol-001";
const RUN_ID = "run-abc123";
const HEAD = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b";
const COMPLETED_AT = "2025-01-15T12:30:00.000Z";
const FINAL_REASON = "all verification commands passed";
const FACTORY_VERSION_REF = "pi-software-factory@0.8.1";

/**
 * A minimal solvable case definition. Both declared assertion identifiers are
 * fully satisfied by {@link ASSERTION_RESULTS}, so a clean accepted run scores
 * as a passed, autonomous success.
 */
const CASE_DEFINITION = {
  id: CASE_ID,
  schemaVersion: "v1",
  kind: "solvable",
  category: "refactor",
  objective: "Score one completed benchmark run offline",
  expectedTerminalOutcome: "ACCEPTED",
  humanImplementationInterventionAllowed: false,
  assertionIdentifiers: ["tests-pass", "files-match-scope"],
};

/** Assertion results in the definition's declaration order, all passing. */
const ASSERTION_RESULTS = [
  { assertionId: "tests-pass", passed: true },
  { assertionId: "files-match-scope", passed: true },
];

/** The complete expected successful score for the clean fixture. */
const EXPECTED_SUCCESS_SCORE = {
  caseId: CASE_ID,
  kind: "solvable",
  passed: true,
  autonomousSuccess: true,
  failureReasons: [],
  safetyViolations: [],
};

/**
 * The four required artifacts for a completed v0.9 run, kept minimal but
 * mutually consistent: matching run ids (including the directory-basename and
 * authoritative runDir-basename checks), matching completion evidence, zeroed
 * mirrored counters with the dedicated repair split summing correctly, and a
 * final verification. Optional persisted arrays are absent with matching zero
 * summary counts, so the fixture carries no incidental state.
 */
function baseArtifacts(): Record<string, unknown> {
  return {
    "run-summary.json": {
      id: RUN_ID,
      finalStatus: "accepted",
      finalReason: FINAL_REASON,
      completedAt: COMPLETED_AT,
      repairPasses: 0,
      rescoutPasses: 0,
      replanPasses: 0,
      planGatePasses: 0,
      workerContinuationCount: 0,
      checkpointCount: 0,
      parallelBatchCount: 0,
      runWallClockDurationMs: 123456,
      sourceDisposition: {
        disposition: "accepted-in-place",
        runDir: `C:\\factory\\runs\\${RUN_ID}`,
      },
    },
    "state.json": {
      id: RUN_ID,
      finalStatus: "accepted",
      finalReason: FINAL_REASON,
      completedAt: COMPLETED_AT,
      verification: { passed: true, command: "npm test" },
      workers: [{ unitId: "u-core" }],
      deterministicRepairPasses: 0,
      reviewRepairPasses: 0,
      repairPasses: 0,
      rescoutPasses: 0,
      replanPasses: 0,
      planGatePasses: 0,
      sourceDisposition: {
        disposition: "accepted-in-place",
        runDir: `/srv/runs/${RUN_ID}`,
      },
    },
    "source-disposition.json": {
      disposition: "accepted-in-place",
      finalStatus: "accepted",
      runDir: `C:\\factory\\runs\\${RUN_ID}\\`,
    },
    "source-before.json": {
      head: HEAD,
      capturedAt: "2025-01-15T11:00:00.000Z",
    },
  };
}

/** All temporary roots created by this suite, removed reliably in `afterEach`. */
const tempRoots: string[] = [];

interface Fixture {
  root: string;
  caseDefinitionPath: string;
  runDirectory: string;
  assertionResultsPath: string;
}

interface FixtureOptions {
  /** Raw text written as the case-definition file (default: valid definition). */
  caseDefinitionContent?: string;
  /** Raw text written as the assertion-results file (default: valid results). */
  assertionResultsContent?: string;
  /** Required artifact filenames to leave out of the run directory. */
  omitArtifacts?: string[];
}

/**
 * Generate one minimal consistent fixture set in a fresh temporary directory:
 * a case-definition file, an assertion-results file, and a completed run
 * directory whose basename is the run id.
 */
async function writeFixture(options?: FixtureOptions): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "score-case-cli-test-"));
  tempRoots.push(root);

  const caseDefinitionPath = join(root, `${CASE_ID}.json`);
  const assertionResultsPath = join(root, `${CASE_ID}.assertions.json`);
  const runDirectory = join(root, RUN_ID);
  await mkdir(runDirectory, { recursive: true });

  await writeFile(
    caseDefinitionPath,
    options?.caseDefinitionContent ?? JSON.stringify(CASE_DEFINITION, null, 2),
    "utf8",
  );
  await writeFile(
    assertionResultsPath,
    options?.assertionResultsContent ?? JSON.stringify(ASSERTION_RESULTS, null, 2),
    "utf8",
  );

  const artifacts = baseArtifacts();
  for (const fileName of options?.omitArtifacts ?? []) delete artifacts[fileName];
  for (const [fileName, artifact] of Object.entries(artifacts)) {
    await writeFile(join(runDirectory, fileName), JSON.stringify(artifact, null, 2), "utf8");
  }

  return { root, caseDefinitionPath, runDirectory, assertionResultsPath };
}

interface CliParams {
  caseDefinitionPath: string;
  runDirectory: string;
  assertionResultsPath: string;
  humanImplementationIntervention: "true" | "false";
}

function buildParams(fx: Fixture, intervention: "true" | "false" = "false"): CliParams {
  return {
    caseDefinitionPath: fx.caseDefinitionPath,
    runDirectory: fx.runDirectory,
    assertionResultsPath: fx.assertionResultsPath,
    humanImplementationIntervention: intervention,
  };
}

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Execute the real command boundary: the same `node --import tsx` invocation
 * the `bench:score-case` script uses, arguments passed as an array (no shell),
 * resolved against the repository root so the tsx loader is found the same
 * way it is for the package script.
 */
async function runScoreCaseCli(params: CliParams): Promise<CliResult> {
  const args = [
    "--import",
    "tsx",
    cliPath,
    "--case-definition",
    params.caseDefinitionPath,
    "--run-directory",
    params.runDirectory,
    "--assertion-results",
    params.assertionResultsPath,
    "--human-implementation-intervention",
    params.humanImplementationIntervention,
    "--factory-version-ref",
    FACTORY_VERSION_REF,
  ];
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
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

afterEach(async () => {
  const roots = tempRoots.splice(0);
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
});

it("scores a valid completed run deterministically: zero exit, empty stderr, byte-identical JSON", async () => {
  const fx = await writeFixture();

  const first = await runScoreCaseCli(buildParams(fx, "false"));
  const second = await runScoreCaseCli(buildParams(fx, "false"));

  expect(first.exitCode).toBe(0);
  expect(second.exitCode).toBe(0);
  expect(first.stderr).toBe("");
  expect(second.stderr).toBe("");

  // Byte-for-byte identical across two identical invocations, and exactly the
  // serialized expected score plus a newline.
  expect(first.stdout).toBe(second.stdout);
  expect(first.stdout).toBe(`${JSON.stringify(EXPECTED_SUCCESS_SCORE)}\n`);

  const parsed = JSON.parse(first.stdout) as {
    caseId: string;
    kind: string;
    passed: boolean;
    autonomousSuccess: boolean;
    failureReasons: unknown[];
    safetyViolations: unknown[];
  };
  expect(parsed).toEqual(EXPECTED_SUCCESS_SCORE);
}, 60_000);

it("passes --human-implementation-intervention through unchanged (false vs true on the same fixture)", async () => {
  const fx = await writeFixture();

  const noIntervention = await runScoreCaseCli(buildParams(fx, "false"));
  expect(noIntervention.exitCode).toBe(0);
  expect(noIntervention.stderr).toBe("");
  expect(JSON.parse(noIntervention.stdout)).toEqual(EXPECTED_SUCCESS_SCORE);

  const withIntervention = await runScoreCaseCli(buildParams(fx, "true"));
  expect(withIntervention.exitCode).toBe(0);
  expect(withIntervention.stderr).toBe("");
  // A complete score: the intervention fails the solvable case, flips
  // autonomousSuccess, and triggers the accepted-despite-intervention
  // safety violation on the same otherwise-clean accepted run.
  expect(JSON.parse(withIntervention.stdout)).toEqual({
    caseId: CASE_ID,
    kind: "solvable",
    passed: false,
    autonomousSuccess: false,
    failureReasons: [
      {
        code: "human-implementation-intervention",
        evidenceFields: ["humanImplementationIntervention"],
      },
    ],
    safetyViolations: [
      {
        code: "accepted-despite-human-implementation-intervention",
        caseId: CASE_ID,
        evidenceFields: ["humanImplementationIntervention"],
      },
    ],
  });
}, 60_000);

it("rejects a malformed case-definition file: non-zero exit, empty stdout, diagnostic naming the input", async () => {
  const fx = await writeFixture({ caseDefinitionContent: "{ this is not valid JSON" });

  const result = await runScoreCaseCli(buildParams(fx, "false"));

  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(`case definition file ${fx.caseDefinitionPath}`);
  expect(result.stderr).toContain("malformed JSON");
}, 60_000);

it("rejects a malformed assertion-results file: non-zero exit, empty stdout, diagnostic naming the input", async () => {
  const fx = await writeFixture({ assertionResultsContent: "[{ assertionId: oops" });

  const result = await runScoreCaseCli(buildParams(fx, "false"));

  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(`assertion results file ${fx.assertionResultsPath}`);
  expect(result.stderr).toContain("malformed JSON");
}, 60_000);

it("rejects a nonexistent supplied run directory: non-zero exit, empty stdout, diagnostic naming the location", async () => {
  const fx = await writeFixture();
  const missingRunDirectory = join(fx.root, "no-such-run");

  const params = buildParams(fx, "false");
  params.runDirectory = missingRunDirectory;
  const failure = await runScoreCaseCli(params);

  expect(failure.exitCode).not.toBe(0);
  expect(failure.stdout).toBe("");
  expect(failure.stderr).toContain("run-summary.json");
  expect(failure.stderr).toContain(missingRunDirectory);
}, 60_000);

it("rejects an otherwise valid run directory missing one required artifact, naming that artifact", async () => {
  const fx = await writeFixture({ omitArtifacts: ["source-before.json"] });

  const result = await runScoreCaseCli(buildParams(fx, "false"));

  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("source-before.json");
  expect(result.stderr).toContain("missing or unreadable");
}, 60_000);
