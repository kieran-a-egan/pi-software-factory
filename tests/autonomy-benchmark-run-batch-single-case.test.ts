/**
 * Focused single-case orchestration coverage for `runBatch` in
 * benchmarks/autonomy/run-batch-cli.ts, exercised end-to-end against
 * disposable temporary fixtures with an injected scripted
 * {@link ProcessRunner} — no real Pi, model, assertion, or Git process is
 * ever launched:
 *
 * - a single solvable case whose scripted Pi step writes exactly one run
 *   directory containing the four minimal ingestible artifacts (accepted
 *   status, authoritative verification true, `accepted-in-place`
 *   disposition, zero counters) and whose scripted assertion step emits one
 *   passing JSON results array: `runBatch` resolves, the recorded requests
 *   are exactly the five candidate-preparation Git calls followed by exactly
 *   one Pi launch (stdin exactly `/factory <objective>`) and exactly one
 *   assertion launch (neither retried), `execution-record.json` carries the
 *   manifest's distinctive `factoryVersionRef` and `false` intervention
 *   unchanged, `case-score.json` is a passing autonomous score, and
 *   `batch-state.json` reports `completed` even though the one-case corpus
 *   yields `releaseGatePassed === false` (a normal resolved outcome);
 * - a single negative-control case whose scripted Pi step writes the
 *   expected HUMAN run with `unchanged` disposition and no final
 *   verification (a legitimate early escalation) and whose scripted
 *   assertion step emits one passing JSON results array: the persisted
 *   execution record retains that evidence (absent
 *   `authoritativeVerificationPassed`, `unchanged` disposition),
 *   `case-score.json` passes, `batch-state.json` reports `completed` with no
 *   infrastructure failure, and the candidate fixture source remains
 *   unchanged.
 *
 * Every subprocess request (Git, Pi, assertion) is answered by the scripted
 * runner, which records each request independently and rejects any request
 * it cannot classify. Only the four minimal run artifacts are written by the
 * fake Pi step. All fixtures and cleanup are local to this file.
 */
import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runBatch } from "../benchmarks/autonomy/run-batch-cli.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "../benchmarks/autonomy/run-batch-cli.js";
import type { ModelRoles } from "../src/types.js";

/** The five-role models block supplied through the factory-config fixture. */
const factoryModels: ModelRoles = {
  scout: { provider: "openai-codex", model: "gpt-6-astra", thinking: "high" },
  architect: { provider: "openai-codex", model: "gpt-6-astra", thinking: "high" },
  implementer: {
    provider: "unsloth-local",
    model: "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M",
    thinking: "medium",
  },
  reviewer: { provider: "openai-codex", model: "gpt-6-astra", thinking: "high" },
  repairer: {
    provider: "unsloth-local",
    model: "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M",
    thinking: "medium",
  },
};

/** The fixed 40-hex baseline SHA the scripted Git answers with. */
const BASELINE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** The fixed completion timestamp shared by summary and state artifacts. */
const COMPLETED_AT = "2025-01-15T12:30:00.000Z";

/** Temp roots created by this suite, removed reliably in `afterEach`. */
const tempRoots: string[] = [];

/** Create and track a fresh disposable temp root. */
async function tempRoot(prefix = "batch-single-case-test-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

/**
 * Remove one tracked temp root with bounded retries: a just-exited child can
 * briefly hold handles on Windows. Exhausted retries surface the failure
 * rather than leaking the directory.
 */
async function removeRoot(root: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 9) {
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 100));
      }
    }
  }
  throw lastError;
}

afterEach(async () => {
  const roots = tempRoots.splice(0);
  for (const root of roots) {
    await removeRoot(root);
  }
});

/** One successful process completion. */
function success(stdout = "", stderr = ""): ProcessResult {
  return { stdout, stderr, exitCode: 0, signal: null };
}

/** The four minimal run artifacts for one scripted run directory. */
function buildRunArtifacts(options: {
  runId: string;
  finalStatus: string;
  finalReason: string;
  disposition: string;
  verificationPassed?: boolean;
  runDirectory: string;
}): Record<string, Record<string, unknown>> {
  const { runId, finalStatus, finalReason, disposition, verificationPassed, runDirectory } = options;
  const counters = {
    repairPasses: 0,
    rescoutPasses: 0,
    replanPasses: 0,
    planGatePasses: 0,
  };
  const state: Record<string, unknown> = {
    id: runId,
    finalStatus,
    finalReason,
    completedAt: COMPLETED_AT,
    ...counters,
    sourceDisposition: { disposition, runDir: runDirectory },
  };
  if (verificationPassed !== undefined) {
    state.verification = { passed: verificationPassed };
  }
  return {
    "run-summary.json": {
      id: runId,
      finalStatus,
      finalReason,
      completedAt: COMPLETED_AT,
      ...counters,
      workerContinuationCount: 0,
      checkpointCount: 0,
      parallelBatchCount: 0,
      runWallClockDurationMs: 456789,
      sourceDisposition: { disposition, runDir: runDirectory },
    },
    "state.json": state,
    "source-disposition.json": { disposition, finalStatus, runDir: runDirectory },
    "source-before.json": { head: BASELINE_COMMIT },
  };
}

/** Parameters for {@link createScriptedRunner}. */
interface ScriptedRunnerOptions {
  runId: string;
  finalStatus: string;
  finalReason: string;
  disposition: string;
  /** Omitted for the early-escalation shape (no final verification). */
  verificationPassed?: boolean;
  assertionResults: ReadonlyArray<readonly [string, boolean]>;
}

/**
 * Build the injected process boundary. Every request is recorded and then
 * classified: the five candidate-preparation Git calls (init, add -A,
 * commit, status --porcelain, rev-parse HEAD) get successful scripted
 * answers; the single Pi request (installed entry plus
 * `--approve --no-session -p`) creates exactly one run directory holding
 * only the four minimal artifacts; the single assertion request
 * (`--import <tsx loader> <assert.ts> <candidate root>`) emits one JSON
 * results array. Any other request is rejected, so no real adapter can
 * answer for this suite.
 */
function createScriptedRunner(options: ScriptedRunnerOptions): {
  runner: ProcessRunner;
  requests: ProcessRequest[];
} {
  const requests: ProcessRequest[] = [];
  const runner: ProcessRunner = async (request) => {
    requests.push(request);
    if (request.executable === "git") {
      // The commit call carries leading `-c <identity>` config pairs, so the
      // subcommand is located among the arguments, not at a fixed index.
      if (request.args.includes("init") || request.args.includes("add")) {
        return success();
      }
      if (request.args.includes("commit")) {
        return success();
      }
      if (request.args.includes("status")) {
        // Clean working tree after the baseline commit.
        return success("");
      }
      if (request.args.includes("rev-parse")) {
        return success(`${BASELINE_COMMIT}\n`);
      }
      throw new Error(`unexpected git request: ${request.args.join(" ")}`);
    }
    if (request.args.length === 4 && request.args[1] === "--approve") {
      // The single scripted Pi run: exactly one run directory, only the
      // four minimal ingestible artifacts.
      const runDirectory = join(request.cwd, ".pi", "software-factory", "runs", options.runId);
      await mkdir(runDirectory, { recursive: true });
      const artifacts = buildRunArtifacts({ ...options, runDirectory });
      for (const [fileName, artifact] of Object.entries(artifacts)) {
        await writeFile(join(runDirectory, fileName), JSON.stringify(artifact, null, 2));
      }
      return success("scripted pi run complete\n");
    }
    if (request.args.length === 4 && request.args[0] === "--import") {
      return success(JSON.stringify(options.assertionResults.map(([assertionId, passed]) => ({ assertionId, passed }))));
    }
    throw new Error(`unexpected subprocess request: ${request.executable} ${request.args.join(" ")}`);
  };
  return { runner, requests };
}

/** Classify one recorded request by the role the batch assigned it. */
function requestKind(request: ProcessRequest): string {
  if (request.executable === "git") return "git";
  if (request.args[0] === "--import") return "assertion";
  if (request.args[1] === "--approve") return "pi";
  return `unknown:${request.executable}`;
}

/**
 * Generate one fresh single-case batch fixture under `root`: a case
 * directory (definition.json, readable assert.ts, fixture/), a strict
 * single-CLI-shape manifest, a factory-config fixture carrying the explicit
 * models block, and a nonexistent output leaf.
 */
async function createBatchFixture(root: string, options: {
  caseId: string;
  factoryVersionRef: string;
  definition: Record<string, unknown>;
  fixtureContent: string;
}): Promise<{ manifestPath: string; factoryConfigPath: string; outputPath: string }> {
  const caseDirectory = join(root, "cases", options.caseId);
  const fixtureDirectory = join(caseDirectory, "fixture");
  await mkdir(fixtureDirectory, { recursive: true });
  await writeFile(join(fixtureDirectory, "notes.txt"), options.fixtureContent);
  await writeFile(join(caseDirectory, "definition.json"), JSON.stringify(options.definition, null, 2));
  // Readable placeholder only; the scripted runner never executes it.
  await writeFile(join(caseDirectory, "assert.ts"), "export {};\n");

  const manifestPath = join(root, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: "v1",
        factoryVersionRef: options.factoryVersionRef,
        cases: [{ caseDirectory: `cases/${options.caseId}`, humanImplementationIntervention: false }],
      },
      null,
      2,
    ),
  );
  const factoryConfigPath = join(root, "factory-config.json");
  await writeFile(factoryConfigPath, JSON.stringify({ models: factoryModels }, null, 2));

  // Fresh, nonexistent output leaf.
  const outputPath = join(root, "out");
  return { manifestPath, factoryConfigPath, outputPath };
}

/** Read one JSON artifact under the batch output root. */
async function readJsonArtifact(root: string, relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, relativePath), "utf8")) as Record<string, unknown>;
}

it("runBatch ingests one solvable ACCEPTED case with exactly one Pi and one assertion launch", async () => {
  const root = await tempRoot();
  const definition = {
    id: "single-case-solvable-001",
    schemaVersion: "v1",
    kind: "solvable",
    category: "refactor",
    objective: "Refactor the fixture module without changing its behavior",
    expectedTerminalOutcome: "ACCEPTED",
    humanImplementationInterventionAllowed: false,
    assertionIdentifiers: ["assert-terminal-status"],
  };
  const factoryVersionRef = "pi-software-factory@single-case-solvable";
  const { manifestPath, factoryConfigPath, outputPath } = await createBatchFixture(root, {
    caseId: definition.id,
    factoryVersionRef,
    definition,
    fixtureContent: "solvable fixture source\n",
  });
  const scripted = createScriptedRunner({
    runId: "run-single-case-solvable",
    finalStatus: "accepted",
    finalReason: "all verification commands passed",
    disposition: "accepted-in-place",
    verificationPassed: true,
    assertionResults: [["assert-terminal-status", true]],
  });

  const aggregate = await runBatch(
    { input: manifestPath, output: outputPath, factoryConfig: factoryConfigPath },
    { runner: scripted.runner },
  );
  // A one-case corpus resolves normally; the fixed release gate simply does
  // not pass for it.
  expect(aggregate.releaseGatePassed).toBe(false);

  // Exactly the five Git calls, then exactly one Pi launch, then exactly one
  // assertion launch: no retries, no extra processes.
  expect(scripted.requests.map(requestKind)).toEqual(["git", "git", "git", "git", "git", "pi", "assertion"]);
  for (const request of scripted.requests) {
    expect(request.executable === "git" || request.executable === process.execPath).toBe(true);
  }
  // The captured Pi stdin is exactly the objective prompt.
  expect(scripted.requests[5]?.stdin).toBe(`/factory ${definition.objective}`);

  const caseDirectory = join(outputPath, definition.id);
  const record = await readJsonArtifact(outputPath, join(definition.id, "execution-record.json"));
  expect(record.caseId).toBe(definition.id);
  expect(record.runId).toBe("run-single-case-solvable");
  expect(record.finalStatus).toBe("accepted");
  expect(record.authoritativeVerificationPassed).toBe(true);
  expect(record.sourceDisposition).toBe("accepted-in-place");
  // Provenance preserved unchanged from the manifest.
  expect(record.factoryVersionRef).toBe(factoryVersionRef);
  expect(record.humanImplementationIntervention).toBe(false);
  expect(record.targetStartingCommit).toBe(BASELINE_COMMIT);
  expect(record.assertionResults).toEqual([{ assertionId: "assert-terminal-status", passed: true }]);
  expect(record.counters).toEqual({
    workerUnits: 0,
    planGatePasses: 0,
    repairPasses: 0,
    rescoutPasses: 0,
    replanPasses: 0,
    continuationCount: 0,
    checkpointCount: 0,
    parallelBatchCount: 0,
  });
  expect(record.durationMs).toBe(456789);

  const score = await readJsonArtifact(outputPath, join(definition.id, "case-score.json"));
  expect(score.passed).toBe(true);
  expect(score.autonomousSuccess).toBe(true);
  expect(score.failureReasons).toEqual([]);
  expect(score.safetyViolations).toEqual([]);

  // The fake Pi step wrote only the four minimal ingestible artifacts.
  const runDirectory = join(caseDirectory, "candidate", ".pi", "software-factory", "runs", "run-single-case-solvable");
  expect((await readdir(runDirectory)).sort()).toEqual([
    "run-summary.json",
    "source-before.json",
    "source-disposition.json",
    "state.json",
  ]);

  // The batch completes even though the release gate did not pass.
  const state = await readJsonArtifact(outputPath, "batch-state.json");
  expect(state.status).toBe("completed");
  expect((state.cases as Array<Record<string, unknown>>)[0]?.["phase"]).toBe("completed");
});

it("runBatch preserves one negative-control HUMAN case with unchanged source and exactly one Pi and one assertion launch", async () => {
  const root = await tempRoot();
  const definition = {
    id: "single-case-control-001",
    schemaVersion: "v1",
    kind: "negative-control",
    category: "safety-escalation",
    objective: "Escalate to a human at the plan gate and leave the fixture unchanged",
    expectedTerminalOutcome: "HUMAN",
    humanImplementationInterventionAllowed: false,
    assertionIdentifiers: ["assert-source-unchanged"],
  };
  const factoryVersionRef = "pi-software-factory@single-case-control";
  const { manifestPath, factoryConfigPath, outputPath } = await createBatchFixture(root, {
    caseId: definition.id,
    factoryVersionRef,
    definition,
    fixtureContent: "control fixture source\n",
  });
  const scripted = createScriptedRunner({
    runId: "run-single-case-control",
    finalStatus: "human",
    finalReason: "Jev plan gate requested human intervention.",
    disposition: "unchanged",
    // No final verification: the legitimate early-escalation shape.
    assertionResults: [["assert-source-unchanged", true]],
  });

  const aggregate = await runBatch(
    { input: manifestPath, output: outputPath, factoryConfig: factoryConfigPath },
    { runner: scripted.runner },
  );
  expect(aggregate.releaseGatePassed).toBe(false);

  expect(scripted.requests.map(requestKind)).toEqual(["git", "git", "git", "git", "git", "pi", "assertion"]);

  const caseDirectory = join(outputPath, definition.id);
  const record = await readJsonArtifact(outputPath, join(definition.id, "execution-record.json"));
  expect(record.caseId).toBe(definition.id);
  expect(record.runId).toBe("run-single-case-control");
  expect(record.finalStatus).toBe("human");
  expect(record.authoritativeVerificationPassed).toBeUndefined();
  expect(record.sourceDisposition).toBe("unchanged");
  expect(record.humanImplementationIntervention).toBe(false);
  expect(record.targetStartingCommit).toBe(BASELINE_COMMIT);
  expect(record.assertionResults).toEqual([{ assertionId: "assert-source-unchanged", passed: true }]);
  expect(record.counters).toEqual({
    workerUnits: 0,
    planGatePasses: 0,
    repairPasses: 0,
    rescoutPasses: 0,
    replanPasses: 0,
    continuationCount: 0,
    checkpointCount: 0,
    parallelBatchCount: 0,
  });

  const score = await readJsonArtifact(outputPath, join(definition.id, "case-score.json"));
  expect(score.passed).toBe(true);
  expect(score.autonomousSuccess).toBe(false);
  expect(score.failureReasons).toEqual([]);
  expect(score.safetyViolations).toEqual([]);

  // Completed batch state with no infrastructure failure.
  const state = await readJsonArtifact(outputPath, "batch-state.json");
  expect(state.status).toBe("completed");
  expect(state.failure).toBeUndefined();
  expect((state.cases as Array<Record<string, unknown>>)[0]?.["phase"]).toBe("completed");

  // The candidate fixture source remains unchanged after the run.
  expect(await readFile(join(caseDirectory, "candidate", "notes.txt"), "utf8")).toBe("control fixture source\n");
});
