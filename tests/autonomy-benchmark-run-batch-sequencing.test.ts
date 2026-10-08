/**
 * Focused multi-case sequencing coverage for `runBatch` in
 * benchmarks/autonomy/run-batch-cli.ts, exercised end-to-end against
 * disposable temporary fixtures with an injected scripted
 * {@link ProcessRunner} — no real Pi, model, assertion, or Git process is
 * ever launched:
 *
 * - a two-case solvable batch whose strict manifest order deliberately
 *   differs from the lexical case-id order: `runBatch` resolves normally and
 *   the recorded requests are exactly `init, add, commit, status, rev-parse,
 *   Pi, assertion` attributed to case 1's candidate root, then the same
 *   sequence attributed to case 2's candidate root — exactly one Pi launch
 *   (stdin exactly `/factory <objective>`) and one assertion launch per case,
 *   with no overlapping runner invocations. At case 2's first preparation
 *   request, case 1's batch-state entry is already `completed` with its
 *   `execution-record.json` and `case-score.json` persisted, both records
 *   carry their own case/run identity with the shared baseline and passing
 *   verification/assertion evidence, both scores are passing autonomous
 *   successes, and `batch-state.json` reports `completed` in manifest order
 *   with `releaseGatePassed === false` (a normal resolved outcome);
 * - a three-case batch (manifest order again deliberately non-lexical) in
 *   which case 1 succeeds and case 2's sole scripted Pi response succeeds
 *   without writing any Factory run directory: `runBatch` rejects with the
 *   missing-run-directory diagnostic, case 1's `execution-record.json` and
 *   `case-score.json` (byte-captured at case 2's first preparation request)
 *   remain byte-for-byte unchanged, `batch-state.json` reports `failed` with
 *   `failure.caseId` equal to case 2 and `failure.phase` equal to
 *   `discovering-run`, case 3 remains `unstarted` with no output directory,
 *   and the complete request trace ends after case 2's five Git calls and
 *   exactly one Pi launch — no case 2 assertion, no case 2 retry, no case 3
 *   request.
 *
 * Every subprocess request (Git, Pi, assertion) is answered by the scripted
 * runner, which records each request, rejects any request it cannot classify
 * and any unknown candidate root, holds every scripted response pending
 * across a deterministic asynchronous (microtask) checkpoint, tracks the
 * completed responses per case, and flags any request issued while a prior
 * response is still unresolved — so overlapping or unawaited invocations are
 * detected without sleeps or timing thresholds. Only the four minimal run
 * artifacts are written by the fake Pi step. All fixtures and cleanup are
 * local to this file.
 */
import { afterEach, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
async function tempRoot(prefix = "batch-sequencing-test-"): Promise<string> {
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

/** The five candidate-preparation Git request kinds, in execution order. */
const PREPARATION_KINDS = ["git:init", "git:add", "git:commit", "git:status", "git:rev-parse"] as const;

/** One scripted response held pending across the deterministic release checkpoint. */
interface PendingResponse {
  caseId: string;
  kind: string;
  result: ProcessResult;
  resolve: (result: ProcessResult) => void;
}

/**
 * The four minimal run artifacts for one scripted run directory, in the fixed
 * successful solvable shape: accepted status, authoritative verification
 * true, `accepted-in-place` disposition, zero counters, and the scripted
 * baseline as the authoritative starting commit.
 */
function buildRunArtifacts(runId: string, runDirectory: string): Record<string, Record<string, unknown>> {
  const counters = {
    repairPasses: 0,
    rescoutPasses: 0,
    replanPasses: 0,
    planGatePasses: 0,
  };
  return {
    "run-summary.json": {
      id: runId,
      finalStatus: "accepted",
      finalReason: "all verification commands passed",
      completedAt: COMPLETED_AT,
      ...counters,
      workerContinuationCount: 0,
      checkpointCount: 0,
      parallelBatchCount: 0,
      runWallClockDurationMs: 456789,
      sourceDisposition: { disposition: "accepted-in-place", runDir: runDirectory },
    },
    "state.json": {
      id: runId,
      finalStatus: "accepted",
      finalReason: "all verification commands passed",
      completedAt: COMPLETED_AT,
      ...counters,
      sourceDisposition: { disposition: "accepted-in-place", runDir: runDirectory },
      verification: { passed: true },
    },
    "source-disposition.json": {
      disposition: "accepted-in-place",
      finalStatus: "accepted",
      runDir: runDirectory,
    },
    "source-before.json": { head: BASELINE_COMMIT },
  };
}

/** One scripted case, keyed by its candidate root. */
interface ScriptedCase {
  caseId: string;
  candidateRoot: string;
  runId: string;
  objective: string;
  assertionId: string;
  /** False only for the single missing-Factory-run failure case. */
  produceRunDirectory: boolean;
}

/** Test-local deterministic checkpoints invoked by the scripted runner. */
interface ScriptedRunnerHooks {
  /**
   * Invoked exactly once per case, before answering that case's first
   * candidate-preparation Git request.
   */
  onPreparationStart?: (caseId: string) => Promise<void> | void;
}

/**
 * Build the injected process boundary. Every request is recorded and then
 * classified: the five candidate-preparation Git calls (init, add -A,
 * commit, status --porcelain, rev-parse HEAD) get successful scripted
 * answers; the single Pi request (installed entry plus
 * `--approve --no-session -p`) creates exactly one run directory holding
 * only the four minimal artifacts (unless the scripted case suppresses it,
 * which exercises only the existing discovering-run infrastructure
 * failure); the single assertion request (`--import <tsx loader>
 * <assert.ts> <candidate root>`) emits one declared passing result. Any
 * unclassifiable request or unknown candidate root is rejected, so no real
 * adapter can answer for this suite. Each response is held pending across a
 * deterministic microtask checkpoint, completed responses are tracked per
 * case, and any request issued while a prior response is unresolved is
 * flagged as overlap.
 */
function createScriptedRunner(
  cases: ScriptedCase[],
  hooks: ScriptedRunnerHooks = {},
): {
  runner: ProcessRunner;
  requests: ProcessRequest[];
  completed: Array<{ caseId: string; kind: string }>;
  maxConcurrent: () => number;
  overlapObserved: () => boolean;
  drain: () => Promise<void>;
} {
  const requests: ProcessRequest[] = [];
  const completed: Array<{ caseId: string; kind: string }> = [];
  const pending = new Set<PendingResponse>();
  const releaseChains: Promise<void>[] = [];
  let active = 0;
  let maxActive = 0;
  let overlap = false;
  const preparationStarted = new Set<string>();

  const release = (entry: PendingResponse): void => {
    if (!pending.delete(entry)) return;
    completed.push({ caseId: entry.caseId, kind: entry.kind });
    entry.resolve(entry.result);
  };

  const runner: ProcessRunner = async (request) => {
    requests.push(request);
    active += 1;
    maxActive = Math.max(maxActive, active);
    // A new request while any prior scripted response is still unresolved
    // means the caller moved on before awaiting it — overlapping
    // invocations, which sequential execution must not produce.
    if (pending.size > 0) overlap = true;
    try {
      const script = cases.find((caseScript) => caseScript.candidateRoot === request.cwd);
      if (script === undefined) {
        throw new Error(`unexpected candidate root: ${request.cwd}`);
      }
      let result: ProcessResult;
      if (request.executable === "git") {
        if (!preparationStarted.has(script.caseId)) {
          preparationStarted.add(script.caseId);
          const hook = hooks.onPreparationStart;
          if (hook !== undefined) await hook(script.caseId);
        }
        // The commit call carries leading `-c <identity>` config pairs, so
        // the subcommand is located among the arguments, not at a fixed
        // index.
        switch (gitSubcommand(request.args)) {
          case "init":
          case "add":
          case "commit":
            result = success();
            break;
          case "status":
            // Clean working tree after the baseline commit.
            result = success("");
            break;
          case "rev-parse":
            result = success(`${BASELINE_COMMIT}\n`);
            break;
          default:
            throw new Error(`unexpected git request: ${request.args.join(" ")}`);
        }
      } else if (request.args.length === 4 && request.args[1] === "--approve") {
        // The single scripted Pi launch for this case: all five preparation
        // responses for this candidate root must have *completed* (not just
        // been requested), and stdin must be the exact objective prompt.
        const preparationDone = new Set(
          completed
            .filter((done) => done.caseId === script.caseId && done.kind.startsWith("git:"))
            .map((done) => done.kind),
        );
        if (PREPARATION_KINDS.some((kind) => !preparationDone.has(kind))) {
          throw new Error(`candidate preparation incomplete before Pi for ${script.caseId}`);
        }
        if (request.stdin !== `/factory ${script.objective}`) {
          throw new Error(`unexpected Pi stdin for ${script.caseId}: ${JSON.stringify(request.stdin)}`);
        }
        if (script.produceRunDirectory) {
          // Exactly one run directory, only the four minimal ingestible
          // artifacts.
          const runDirectory = join(request.cwd, ".pi", "software-factory", "runs", script.runId);
          await mkdir(runDirectory, { recursive: true });
          const artifacts = buildRunArtifacts(script.runId, runDirectory);
          for (const [fileName, artifact] of Object.entries(artifacts)) {
            await writeFile(join(runDirectory, fileName), JSON.stringify(artifact, null, 2));
          }
        }
        result = success("scripted pi run complete\n");
      } else if (request.args.length === 4 && request.args[0] === "--import") {
        // The single scripted assertion launch against this candidate root.
        if (request.args[3] !== request.cwd) {
          throw new Error(`unexpected assertion candidate argument for ${script.caseId}`);
        }
        result = success(JSON.stringify([{ assertionId: script.assertionId, passed: true }]));
      } else {
        throw new Error(`unexpected subprocess request: ${request.executable} ${request.args.join(" ")}`);
      }
      const entry: PendingResponse = {
        caseId: script.caseId,
        kind: requestKind(request),
        result,
        resolve: () => {},
      };
      pending.add(entry);
      // Deterministic asynchronous checkpoint: the response is released only
      // after a fixed microtask chain (no sleeps or timing thresholds). A
      // caller that fires the next request without awaiting this one finds
      // it still pending, which is exactly the overlap flag set above.
      let chain: Promise<void> = Promise.resolve();
      for (let turn = 0; turn < 4; turn += 1) {
        chain = chain.then(() => undefined);
      }
      releaseChains.push(chain.then(() => release(entry)));
      return new Promise<ProcessResult>((resolveResult) => {
        entry.resolve = resolveResult;
      });
    } finally {
      active -= 1;
    }
  };

  /** Settle every remaining scripted response deterministically. */
  const drain = async (): Promise<void> => {
    await Promise.all(releaseChains);
    for (const entry of [...pending]) {
      release(entry);
    }
  };

  return { runner, requests, completed, maxConcurrent: () => maxActive, overlapObserved: () => overlap, drain };
}

/** Locate the Git subcommand among the arguments (commit carries `-c` pairs). */
function gitSubcommand(args: readonly string[]): string {
  if (args.includes("init")) return "init";
  if (args.includes("add")) return "add";
  if (args.includes("commit")) return "commit";
  if (args.includes("status")) return "status";
  if (args.includes("rev-parse")) return "rev-parse";
  return "unknown";
}

/** Classify one recorded request by the role the batch assigned it. */
function requestKind(request: ProcessRequest): string {
  if (request.executable === "git") return `git:${gitSubcommand(request.args)}`;
  if (request.args[0] === "--import") return "assertion";
  if (request.args[1] === "--approve") return "pi";
  return `unknown:${request.executable}`;
}

/** Escape literal text for safe embedding in a RegExp pattern. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One fixture case: validated definition, readable assert.ts, small fixture. */
interface FixtureCaseSpec {
  caseId: string;
  objective: string;
  assertionId: string;
  fixtureContent: string;
}

/**
 * Generate one fresh multi-case batch fixture under `root`: a directory per
 * case (definition.json, readable assert.ts, fixture/), a strict manifest
 * preserving the requested case order, a factory-config fixture carrying the
 * explicit five-role models block, and a nonexistent output leaf.
 */
async function createBatchFixture(
  root: string,
  options: { factoryVersionRef: string; cases: FixtureCaseSpec[] },
): Promise<{ manifestPath: string; factoryConfigPath: string; outputPath: string }> {
  for (const spec of options.cases) {
    const caseDirectory = join(root, "cases", spec.caseId);
    const fixtureDirectory = join(caseDirectory, "fixture");
    await mkdir(fixtureDirectory, { recursive: true });
    await writeFile(join(fixtureDirectory, "notes.txt"), spec.fixtureContent);
    await writeFile(
      join(caseDirectory, "definition.json"),
      JSON.stringify(
        {
          id: spec.caseId,
          schemaVersion: "v1",
          kind: "solvable",
          category: "refactor",
          objective: spec.objective,
          expectedTerminalOutcome: "ACCEPTED",
          humanImplementationInterventionAllowed: false,
          assertionIdentifiers: [spec.assertionId],
        },
        null,
        2,
      ),
    );
    // Readable placeholder only; the scripted runner never executes it.
    await writeFile(join(caseDirectory, "assert.ts"), "export {};\n");
  }

  const manifestPath = join(root, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: "v1",
        factoryVersionRef: options.factoryVersionRef,
        cases: options.cases.map((spec) => ({
          caseDirectory: `cases/${spec.caseId}`,
          humanImplementationIntervention: false,
        })),
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

/** True when the path does not exist. */
async function pathIsMissing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch {
    return true;
  }
}

/** Assert a string captured by a deterministic checkpoint and return it. */
function expectString(value: string | undefined): string {
  expect(value).toBeTypeOf("string");
  return value as string;
}

it("runBatch executes two cases sequentially in manifest order with exactly one Pi and one assertion per case", async () => {
  const root = await tempRoot();
  const caseB = {
    caseId: "seq-batch-b-002",
    objective: "Refactor the batch fixture module without changing its behavior",
    assertionId: "assert-b-terminal-status",
  };
  const caseA = {
    caseId: "seq-batch-a-001",
    objective: "Rename the batch fixture entry point and keep the behavior identical",
    assertionId: "assert-a-terminal-status",
  };
  const factoryVersionRef = "pi-software-factory@seq-batch";
  // Manifest order is B then A — deliberately not the lexical case-id order.
  const { manifestPath, factoryConfigPath, outputPath } = await createBatchFixture(root, {
    factoryVersionRef,
    cases: [
      { caseId: caseB.caseId, objective: caseB.objective, assertionId: caseB.assertionId, fixtureContent: "case b fixture source\n" },
      { caseId: caseA.caseId, objective: caseA.objective, assertionId: caseA.assertionId, fixtureContent: "case a fixture source\n" },
    ],
  });
  const candidateRootB = join(outputPath, caseB.caseId, "candidate");
  const candidateRootA = join(outputPath, caseA.caseId, "candidate");

  let secondCasePreparationObserved = false;
  const scripted = createScriptedRunner(
    [
      {
        caseId: caseB.caseId,
        candidateRoot: candidateRootB,
        runId: "run-seq-batch-b",
        objective: caseB.objective,
        assertionId: caseB.assertionId,
        produceRunDirectory: true,
      },
      {
        caseId: caseA.caseId,
        candidateRoot: candidateRootA,
        runId: "run-seq-batch-a",
        objective: caseA.objective,
        assertionId: caseA.assertionId,
        produceRunDirectory: true,
      },
    ],
    {
      // Deterministic checkpoint at case 2's first preparation request: case 1
      // must already be fully completed with its evidence persisted.
      async onPreparationStart(caseId) {
        if (caseId !== caseA.caseId) return;
        secondCasePreparationObserved = true;
        const state = await readJsonArtifact(outputPath, "batch-state.json");
        const entries = state.cases as Array<Record<string, unknown>>;
        expect(entries[0]?.["caseId"]).toBe(caseB.caseId);
        expect(entries[0]?.["phase"]).toBe("completed");
        expect(entries[1]?.["phase"]).toBe("preparing-candidate");
        const record = JSON.parse(await readFile(join(outputPath, caseB.caseId, "execution-record.json"), "utf8")) as Record<string, unknown>;
        const score = JSON.parse(await readFile(join(outputPath, caseB.caseId, "case-score.json"), "utf8")) as Record<string, unknown>;
        expect(record.caseId).toBe(caseB.caseId);
        expect(record.runId).toBe("run-seq-batch-b");
        expect(score.passed).toBe(true);
      },
    },
  );

  const aggregate = await runBatch(
    { input: manifestPath, output: outputPath, factoryConfig: factoryConfigPath },
    { runner: scripted.runner },
  );
  expect(secondCasePreparationObserved).toBe(true);
  // A two-case corpus resolves normally; the fixed release gate simply does
  // not pass for it.
  expect(aggregate.releaseGatePassed).toBe(false);

  // The exact cwd-attributed request sequence: init, add, commit, status,
  // rev-parse, Pi, assertion for case 1, then the same sequence for case 2
  // — case 1 fully complete before case 2's first request.
  const caseBTrace: Array<{ cwd: string; kind: string }> = [
    ...PREPARATION_KINDS.map((kind) => ({ cwd: candidateRootB, kind })),
    { cwd: candidateRootB, kind: "pi" },
    { cwd: candidateRootB, kind: "assertion" },
  ];
  const caseATrace: Array<{ cwd: string; kind: string }> = [
    ...PREPARATION_KINDS.map((kind) => ({ cwd: candidateRootA, kind })),
    { cwd: candidateRootA, kind: "pi" },
    { cwd: candidateRootA, kind: "assertion" },
  ];
  expect(scripted.requests.map((request) => ({ cwd: request.cwd, kind: requestKind(request) }))).toEqual([
    ...caseBTrace,
    ...caseATrace,
  ]);

  // Exactly one Pi and one assertion launch per case, each with its own
  // objective prompt on stdin.
  const piB = scripted.requests.filter((request) => request.cwd === candidateRootB && requestKind(request) === "pi");
  const assertionB = scripted.requests.filter((request) => request.cwd === candidateRootB && requestKind(request) === "assertion");
  const piA = scripted.requests.filter((request) => request.cwd === candidateRootA && requestKind(request) === "pi");
  const assertionA = scripted.requests.filter((request) => request.cwd === candidateRootA && requestKind(request) === "assertion");
  expect(piB).toHaveLength(1);
  expect(assertionB).toHaveLength(1);
  expect(piA).toHaveLength(1);
  expect(assertionA).toHaveLength(1);
  expect(piB[0]?.stdin).toBe(`/factory ${caseB.objective}`);
  expect(piA[0]?.stdin).toBe(`/factory ${caseA.objective}`);

  // No overlapping runner invocations: no request is ever issued while a
  // prior scripted response is still unresolved, and at most one invocation
  // is in flight.
  expect(scripted.maxConcurrent()).toBe(1);
  expect(scripted.overlapObserved()).toBe(false);

  // The *completed* response sequence (not just the request sequence) shows
  // each case's five preparation responses fully resolved before its Pi
  // launch, and the whole batch in strict order.
  await scripted.drain();
  expect(scripted.completed).toEqual([
    ...PREPARATION_KINDS.map((kind) => ({ caseId: caseB.caseId, kind })),
    { caseId: caseB.caseId, kind: "pi" },
    { caseId: caseB.caseId, kind: "assertion" },
    ...PREPARATION_KINDS.map((kind) => ({ caseId: caseA.caseId, kind })),
    { caseId: caseA.caseId, kind: "pi" },
    { caseId: caseA.caseId, kind: "assertion" },
  ]);

  // Both execution records identify their own case and run, preserve the
  // expected baseline, and carry valid verification/assertion evidence.
  const recordB = await readJsonArtifact(outputPath, join(caseB.caseId, "execution-record.json"));
  expect(recordB.caseId).toBe(caseB.caseId);
  expect(recordB.runId).toBe("run-seq-batch-b");
  expect(recordB.finalStatus).toBe("accepted");
  expect(recordB.authoritativeVerificationPassed).toBe(true);
  expect(recordB.sourceDisposition).toBe("accepted-in-place");
  expect(recordB.factoryVersionRef).toBe(factoryVersionRef);
  expect(recordB.humanImplementationIntervention).toBe(false);
  expect(recordB.targetStartingCommit).toBe(BASELINE_COMMIT);
  expect(recordB.assertionResults).toEqual([{ assertionId: caseB.assertionId, passed: true }]);
  expect(recordB.counters).toEqual({
    workerUnits: 0,
    planGatePasses: 0,
    repairPasses: 0,
    rescoutPasses: 0,
    replanPasses: 0,
    continuationCount: 0,
    checkpointCount: 0,
    parallelBatchCount: 0,
  });
  const recordA = await readJsonArtifact(outputPath, join(caseA.caseId, "execution-record.json"));
  expect(recordA.caseId).toBe(caseA.caseId);
  expect(recordA.runId).toBe("run-seq-batch-a");
  expect(recordA.finalStatus).toBe("accepted");
  expect(recordA.authoritativeVerificationPassed).toBe(true);
  expect(recordA.sourceDisposition).toBe("accepted-in-place");
  expect(recordA.factoryVersionRef).toBe(factoryVersionRef);
  expect(recordA.humanImplementationIntervention).toBe(false);
  expect(recordA.targetStartingCommit).toBe(BASELINE_COMMIT);
  expect(recordA.assertionResults).toEqual([{ assertionId: caseA.assertionId, passed: true }]);
  expect(recordA.counters).toEqual({
    workerUnits: 0,
    planGatePasses: 0,
    repairPasses: 0,
    rescoutPasses: 0,
    replanPasses: 0,
    continuationCount: 0,
    checkpointCount: 0,
    parallelBatchCount: 0,
  });

  // Both case scores report passing autonomous success.
  const scoreB = await readJsonArtifact(outputPath, join(caseB.caseId, "case-score.json"));
  expect(scoreB.passed).toBe(true);
  expect(scoreB.autonomousSuccess).toBe(true);
  expect(scoreB.failureReasons).toEqual([]);
  expect(scoreB.safetyViolations).toEqual([]);
  const scoreA = await readJsonArtifact(outputPath, join(caseA.caseId, "case-score.json"));
  expect(scoreA.passed).toBe(true);
  expect(scoreA.autonomousSuccess).toBe(true);
  expect(scoreA.failureReasons).toEqual([]);
  expect(scoreA.safetyViolations).toEqual([]);

  // The batch completes in manifest order with no infrastructure failure.
  const state = await readJsonArtifact(outputPath, "batch-state.json");
  expect(state.status).toBe("completed");
  expect(state.failure).toBeUndefined();
  expect(state.caseOrder).toEqual([caseB.caseId, caseA.caseId]);
  const entries = state.cases as Array<Record<string, unknown>>;
  expect(entries[0]?.["caseId"]).toBe(caseB.caseId);
  expect(entries[0]?.["phase"]).toBe("completed");
  expect(entries[1]?.["caseId"]).toBe(caseA.caseId);
  expect(entries[1]?.["phase"]).toBe("completed");
});

it("runBatch fails stop at case 2's missing Factory run directory, preserving case 1's evidence and never starting case 3", async () => {
  const root = await tempRoot();
  const caseB = {
    caseId: "seq-fail-b-002",
    objective: "Refactor the failing-batch fixture module without changing its behavior",
    assertionId: "assert-bb-terminal-status",
  };
  const caseA = {
    caseId: "seq-fail-a-001",
    objective: "Rename the failing-batch fixture entry point and keep the behavior identical",
    assertionId: "assert-aa-terminal-status",
  };
  const caseC = {
    caseId: "seq-fail-c-003",
    objective: "Extend the failing-batch fixture with a new helper function",
    assertionId: "assert-cc-terminal-status",
  };
  const factoryVersionRef = "pi-software-factory@seq-fail";
  // Manifest order is B, A, C — deliberately not the lexical case-id order.
  const { manifestPath, factoryConfigPath, outputPath } = await createBatchFixture(root, {
    factoryVersionRef,
    cases: [
      { caseId: caseB.caseId, objective: caseB.objective, assertionId: caseB.assertionId, fixtureContent: "case b fixture source\n" },
      { caseId: caseA.caseId, objective: caseA.objective, assertionId: caseA.assertionId, fixtureContent: "case a fixture source\n" },
      { caseId: caseC.caseId, objective: caseC.objective, assertionId: caseC.assertionId, fixtureContent: "case c fixture source\n" },
    ],
  });
  const candidateRootB = join(outputPath, caseB.caseId, "candidate");
  const candidateRootA = join(outputPath, caseA.caseId, "candidate");
  const candidateRootC = join(outputPath, caseC.caseId, "candidate");

  // Case 2's sole scripted Pi response succeeds but writes no Factory run
  // directory — the single infrastructure failure this suite exercises.
  let case1RecordBytes: string | undefined;
  let case1ScoreBytes: string | undefined;
  const scripted = createScriptedRunner(
    [
      {
        caseId: caseB.caseId,
        candidateRoot: candidateRootB,
        runId: "run-seq-fail-b",
        objective: caseB.objective,
        assertionId: caseB.assertionId,
        produceRunDirectory: true,
      },
      {
        caseId: caseA.caseId,
        candidateRoot: candidateRootA,
        runId: "run-seq-fail-a",
        objective: caseA.objective,
        assertionId: caseA.assertionId,
        produceRunDirectory: false,
      },
      {
        caseId: caseC.caseId,
        candidateRoot: candidateRootC,
        runId: "run-seq-fail-c",
        objective: caseC.objective,
        assertionId: caseC.assertionId,
        produceRunDirectory: true,
      },
    ],
    {
      // Deterministic checkpoint at case 2's first preparation request:
      // capture case 1's persisted evidence bytes before the failure.
      async onPreparationStart(caseId) {
        if (caseId !== caseA.caseId) return;
        const [recordBytes, scoreBytes] = await Promise.all([
          readFile(join(outputPath, caseB.caseId, "execution-record.json"), "utf8"),
          readFile(join(outputPath, caseB.caseId, "case-score.json"), "utf8"),
        ]);
        case1RecordBytes = recordBytes;
        case1ScoreBytes = scoreBytes;
      },
    },
  );

  const case2RunsRoot = join(outputPath, caseA.caseId, "candidate", ".pi", "software-factory", "runs");
  // The diagnostic names the exact missing run root.
  await expect(
    runBatch(
      { input: manifestPath, output: outputPath, factoryConfig: factoryConfigPath },
      { runner: scripted.runner },
    ),
  ).rejects.toThrow(new RegExp(`^Pi produced no factory run directory under ${escapeRegExp(case2RunsRoot)}; exactly one is required$`));

  // Case 1's persisted evidence remains byte-for-byte unchanged and still
  // carries valid successful case evidence and score.
  const recordBytes = expectString(case1RecordBytes);
  const scoreBytes = expectString(case1ScoreBytes);
  expect(await readFile(join(outputPath, caseB.caseId, "execution-record.json"), "utf8")).toBe(recordBytes);
  expect(await readFile(join(outputPath, caseB.caseId, "case-score.json"), "utf8")).toBe(scoreBytes);
  const recordB = JSON.parse(recordBytes) as Record<string, unknown>;
  expect(recordB.caseId).toBe(caseB.caseId);
  expect(recordB.runId).toBe("run-seq-fail-b");
  expect(recordB.finalStatus).toBe("accepted");
  expect(recordB.authoritativeVerificationPassed).toBe(true);
  expect(recordB.targetStartingCommit).toBe(BASELINE_COMMIT);
  const scoreB = JSON.parse(scoreBytes) as Record<string, unknown>;
  expect(scoreB.passed).toBe(true);
  expect(scoreB.autonomousSuccess).toBe(true);

  // The batch state identifies case 2 as the failed case at the
  // discovering-run phase; case 1 completed, case 3 never started.
  const state = await readJsonArtifact(outputPath, "batch-state.json");
  expect(state.status).toBe("failed");
  const failure = state.failure as Record<string, unknown> | undefined;
  expect(failure).toBeDefined();
  expect(failure?.caseId).toBe(caseA.caseId);
  expect(failure?.phase).toBe("discovering-run");
  expect(typeof failure?.error).toBe("string");
  expect(state.caseOrder).toEqual([caseB.caseId, caseA.caseId, caseC.caseId]);
  const entries = state.cases as Array<Record<string, unknown>>;
  expect(entries[0]?.["caseId"]).toBe(caseB.caseId);
  expect(entries[0]?.["phase"]).toBe("completed");
  expect(entries[1]?.["caseId"]).toBe(caseA.caseId);
  expect(entries[1]?.["phase"]).toBe("failed");
  expect(entries[2]?.["caseId"]).toBe(caseC.caseId);
  expect(entries[2]?.["phase"]).toBe("unstarted");

  // The complete cwd-attributed request trace ends after case 2's five Git
  // calls and exactly one Pi launch attributed to case 2: no case 2
  // assertion, no case 2 Pi retry, and no case 3 request of any kind.
  const expectedTrace: Array<{ cwd: string; kind: string }> = [
    ...PREPARATION_KINDS.map((kind) => ({ cwd: candidateRootB, kind })),
    { cwd: candidateRootB, kind: "pi" },
    { cwd: candidateRootB, kind: "assertion" },
    ...PREPARATION_KINDS.map((kind) => ({ cwd: candidateRootA, kind })),
    { cwd: candidateRootA, kind: "pi" },
  ];
  expect(scripted.requests.map((request) => ({ cwd: request.cwd, kind: requestKind(request) }))).toEqual(
    expectedTrace,
  );

  // No overlapping invocations, and the completed response sequence stops at
  // case 2's single Pi response — no case 2 assertion, no case 2 retry, no
  // case 3 work.
  await scripted.drain();
  expect(scripted.maxConcurrent()).toBe(1);
  expect(scripted.overlapObserved()).toBe(false);
  expect(scripted.completed).toEqual([
    ...PREPARATION_KINDS.map((kind) => ({ caseId: caseB.caseId, kind })),
    { caseId: caseB.caseId, kind: "pi" },
    { caseId: caseB.caseId, kind: "assertion" },
    ...PREPARATION_KINDS.map((kind) => ({ caseId: caseA.caseId, kind })),
    { caseId: caseA.caseId, kind: "pi" },
  ]);

  // Case 2's Pi wrote no run directory; case 3's output directory was never
  // created.
  expect(await pathIsMissing(case2RunsRoot)).toBe(true);
  expect(await pathIsMissing(join(outputPath, caseC.caseId))).toBe(true);
});
