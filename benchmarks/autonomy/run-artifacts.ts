/**
 * Deterministic ingestion of one completed factory v0.9 run directory into an
 * isolated v1 {@link BenchmarkExecutionRecord}.
 *
 * {@link ingestRunArtifacts} reads exactly four fixed artifact filenames from
 * the supplied run directory, in this fixed order:
 *
 *   1. `run-summary.json`   — terminal status/reason, mirrored counters,
 *                             continuation/checkpoint/parallel-batch counts,
 *                             wall-clock duration, run id, completion time,
 *                             and the state-level source-disposition mirror.
 *   2. `state.json`         — the persisted FactoryRunState: final verification
 *                             result, worker reports, mirrored counters,
 *                             persisted checkpoint/continuation/parallel-batch
 *                             arrays, and its source-disposition mirror.
 *   3. `source-disposition.json` — the *authoritative* source disposition,
 *                             terminal status, and run directory.
 *   4. `source-before.json` — the pre-run source capture, whose `head` is the
 *                             *authoritative* starting commit.
 *
 * Authority rules (never substituted, never discovered):
 * - `source-disposition.json.disposition` is the only source of
 *   `sourceDisposition`; the summary/state mirrors must agree with it.
 * - `source-before.json.head` is the only source of
 *   `targetStartingCommit`; it must be nonempty (an unborn repository has no
 *   starting provenance and is an ingestion error).
 * - `state.json.verification.passed` is the only source of
 *   `authoritativeVerificationPassed`; a present value must be explicitly
 *   boolean. `verification.json` and `verification-after-*.json` may predate
 *   repairs; they are neither required inputs nor fallbacks. An absent final
 *   verification is incomplete evidence (the record carries no
 *   `authoritativeVerificationPassed`), not an ingestion error, even when an
 *   initial verification artifact exists.
 * - `caseId` and `factoryVersionRef` come only from the caller-supplied
 *   metadata: the artifacts do not establish either.
 * - `workerUnits` is the count of distinct nonempty `state.workers[].unitId`
 *   values; array length overcounts units because the controller appends
 *   implementation continuation reports to `workers`.
 *
 * Identity and completion checks:
 * - `run-summary.json.id`, `state.json.id`, the supplied directory basename,
 *   and the basename of `source-disposition.json.runDir` must all agree.
 *   Bases are extracted with both Windows and POSIX separators, and identity
 *   (not absolute path) is compared so a completed directory can be relocated
 *   with its basename preserved.
 * - Summary and state must have matching, valid `completedAt` values and
 *   matching `finalStatus`/`finalReason`; `source-disposition.json.finalStatus`
 *   must match them, and the summary/state `sourceDisposition` mirrors must
 *   agree with the authoritative disposition and run identity.
 * - Mirrored scalar counters (`repairPasses`, `rescoutPasses`,
 *   `replanPasses`, `planGatePasses`) must agree between state and summary,
 *   and state's `repairPasses` must equal `deterministicRepairPasses` plus
 *   `reviewRepairPasses`; the legacy exception is that a state omitting both
 *   dedicated counters skips only the dedicated reads and sum check (the
 *   aggregate-only `repairPasses` remains required and mirrored), while the
 *   presence of either dedicated counter, including null or malformed values,
 *   restores the full validation.
 * - For the persisted `checkpoints`, `workerContinuations`, and
 *   `parallelBatches` arrays, the summary counts must equal the array lengths;
 *   an absent array (contract-optional) means the summary count must be zero.
 *
 * Ingestion never scores: an absent verification, a present `false`
 * verification, failing assertion results, an explicit intervention boolean,
 * and a known (possibly inappropriate) disposition are preserved unchanged
 * and handed to {@link validateBenchmarkExecutionRecord}, which builds the
 * fresh record.
 * Disagreement between *copies of the same evidence* is an ingestion error;
 * disagreement between evidence and outcome is not. No telemetry is included,
 * and production modules, the scorer, directories beyond the four files,
 * filesystem writes, Git, and the clock are never consulted.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BenchmarkAssertionResult, BenchmarkExecutionRecord } from "./types.js";
import { BENCHMARK_SCHEMA_VERSION } from "./types.js";
import { validateBenchmarkExecutionRecord } from "./validate.js";

/** The four required v0.9 run artifacts, read in this fixed order. */
const RUN_SUMMARY_FILE = "run-summary.json";
const STATE_FILE = "state.json";
const SOURCE_DISPOSITION_FILE = "source-disposition.json";
const SOURCE_BEFORE_FILE = "source-before.json";

/**
 * Explicit caller metadata that run artifacts cannot establish.
 */
export interface IngestRunArtifactsMetadata {
  /** Identifier of the benchmark case definition this run executed (required). */
  caseId: string;
  /** Opaque provenance: which factory build/version produced the run (required). */
  factoryVersionRef: string;
  /** Whether a human implemented the change; used unchanged. */
  humanImplementationIntervention: boolean;
  /** Deterministic assertion results, in the caller's declaration order. */
  readonly assertionResults: ReadonlyArray<BenchmarkAssertionResult>;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * A supported object container is a non-null object whose prototype is
 * exactly `Object.prototype` or `null` (null-prototype dictionaries are
 * retained); arrays, class instances, and other containers are rejected.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`${name} must be an object, got ${describeType(value)}`);
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string, got ${describeType(value)}`);
  return value;
}

function requireNonEmptyString(value: unknown, name: string): string {
  const valueString = requireString(value, name);
  if (valueString.length === 0) throw new Error(`${name} must be a nonempty string`);
  return valueString;
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean, got ${describeType(value)}`);
  return value;
}

function requireNonNegativeSafeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer, got ${describeValue(value)}`);
  }
  return value;
}

function requireFiniteNonNegativeNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite nonnegative number, got ${describeValue(value)}`);
  }
  return value;
}

function requireValidTimestamp(value: unknown, name: string): string {
  const valueString = requireNonEmptyString(value, name);
  if (!Number.isFinite(Date.parse(valueString))) {
    throw new Error(`${name} must be a parseable timestamp, got ${JSON.stringify(valueString)}`);
  }
  return valueString;
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  return describeType(value);
}

/**
 * Read one required run artifact and parse it as a plain JSON object.
 * Missing/unreadable files, malformed JSON, and non-object roots are all
 * ingestion errors that name the artifact.
 */
async function readArtifactObject(runDirectory: string, fileName: string): Promise<Record<string, unknown>> {
  const filePath = join(runDirectory, fileName);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const detail = code ?? (error instanceof Error ? error.message : String(error));
    throw new Error(`${fileName}: required run artifact is missing or unreadable at ${filePath} (${detail})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${fileName}: malformed JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return requireObject(parsed, fileName);
}

/**
 * Extract the final path component of a persisted path, handling both Windows
 * and POSIX separators (and trailing separators) regardless of the platform
 * doing the reading.
 */
function pathBasename(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]+/);
  return parts[parts.length - 1];
}

/**
 * Ingest the four required v0.9 artifacts from a completed run directory into
 * a fresh, validated {@link BenchmarkExecutionRecord}.
 *
 * See the module documentation for the fixed artifact order, authority rules,
 * identity, and completion-evidence checks. Every structural violation throws
 * a descriptive `Error` naming the artifact (and field, where applicable);
 * nothing is defaulted, coerced, substituted, or scored. Telemetry is omitted
 * entirely. The caller's metadata object is never mutated.
 */
export async function ingestRunArtifacts(
  runDirectory: string,
  metadata: IngestRunArtifactsMetadata,
): Promise<BenchmarkExecutionRecord> {
  // Caller metadata: the two required provenance fields the artifacts cannot
  // establish. The remaining fields are validated when the record is built.
  const caseId = requireNonEmptyString(metadata.caseId, "metadata.caseId");
  const factoryVersionRef = requireNonEmptyString(metadata.factoryVersionRef, "metadata.factoryVersionRef");
  const humanImplementationIntervention = requireBoolean(
    metadata.humanImplementationIntervention,
    "metadata.humanImplementationIntervention",
  );
  const assertionResults = metadata.assertionResults;

  // 1. run-summary.json
  const summary = await readArtifactObject(runDirectory, RUN_SUMMARY_FILE);
  const runId = requireNonEmptyString(summary.id, `${RUN_SUMMARY_FILE}.id`);
  const summaryFinalStatus = requireString(summary.finalStatus, `${RUN_SUMMARY_FILE}.finalStatus`);
  const summaryFinalReason = requireNonEmptyString(summary.finalReason, `${RUN_SUMMARY_FILE}.finalReason`);
  const summaryCompletedAt = requireValidTimestamp(summary.completedAt, `${RUN_SUMMARY_FILE}.completedAt`);
  const summaryRepairPasses = requireNonNegativeSafeInteger(summary.repairPasses, `${RUN_SUMMARY_FILE}.repairPasses`);
  const summaryRescoutPasses = requireNonNegativeSafeInteger(
    summary.rescoutPasses,
    `${RUN_SUMMARY_FILE}.rescoutPasses`,
  );
  const summaryReplanPasses = requireNonNegativeSafeInteger(
    summary.replanPasses,
    `${RUN_SUMMARY_FILE}.replanPasses`,
  );
  const summaryPlanGatePasses = requireNonNegativeSafeInteger(
    summary.planGatePasses,
    `${RUN_SUMMARY_FILE}.planGatePasses`,
  );
  const summaryWorkerContinuationCount = requireNonNegativeSafeInteger(
    summary.workerContinuationCount,
    `${RUN_SUMMARY_FILE}.workerContinuationCount`,
  );
  const summaryCheckpointCount = requireNonNegativeSafeInteger(
    summary.checkpointCount,
    `${RUN_SUMMARY_FILE}.checkpointCount`,
  );
  const summaryParallelBatchCount = requireNonNegativeSafeInteger(
    summary.parallelBatchCount,
    `${RUN_SUMMARY_FILE}.parallelBatchCount`,
  );
  const durationMs = requireFiniteNonNegativeNumber(
    summary.runWallClockDurationMs,
    `${RUN_SUMMARY_FILE}.runWallClockDurationMs`,
  );
  const summarySourceDisposition = requireObject(
    summary.sourceDisposition,
    `${RUN_SUMMARY_FILE}.sourceDisposition`,
  );

  // 2. state.json
  const state = await readArtifactObject(runDirectory, STATE_FILE);
  const stateId = requireNonEmptyString(state.id, `${STATE_FILE}.id`);
  const stateCompletedAt = requireValidTimestamp(state.completedAt, `${STATE_FILE}.completedAt`);
  const stateFinalStatus = requireString(state.finalStatus, `${STATE_FILE}.finalStatus`);
  const stateFinalReason = requireString(state.finalReason, `${STATE_FILE}.finalReason`);

  // Authoritative final verification: an absent final verification is
  // incomplete evidence (no value is synthesized); a present value must be a
  // plain object with an explicitly boolean `passed`. No fallback to
  // verification.json / verification-after-*.json.
  let authoritativeVerificationPassed: boolean | undefined;
  if (state.verification !== undefined) {
    const verification = requireObject(state.verification, `${STATE_FILE}.verification`);
    if (verification.passed === undefined) {
      throw new Error(`${STATE_FILE}.verification.passed: missing authoritative verification result`);
    }
    authoritativeVerificationPassed = requireBoolean(
      verification.passed,
      `${STATE_FILE}.verification.passed`,
    );
  }

  // Distinct implemented unit ids: continuation reports appended to `workers`
  // must not inflate the unit count.
  if (!Array.isArray(state.workers)) {
    throw new Error(`${STATE_FILE}.workers must be an array of worker reports, got ${describeType(state.workers)}`);
  }
  const unitIds = new Set<string>();
  for (let i = 0; i < state.workers.length; i++) {
    const report = requireObject(state.workers[i], `${STATE_FILE}.workers[${i}]`);
    const unitId = requireNonEmptyString(report.unitId, `${STATE_FILE}.workers[${i}].unitId`);
    unitIds.add(unitId);
  }
  const workerUnits = unitIds.size;

  // Legacy aggregate-only exception: when state omits both dedicated
  // counters, skip the dedicated reads and sum check; presence of either
  // counter (including null or malformed values) restores the full check.
  const hasDedicatedRepairCounters =
    Object.hasOwn(state, "deterministicRepairPasses") || Object.hasOwn(state, "reviewRepairPasses");
  let stateDeterministicRepairPasses: number | undefined;
  let stateReviewRepairPasses: number | undefined;
  if (hasDedicatedRepairCounters) {
    stateDeterministicRepairPasses = requireNonNegativeSafeInteger(
      state.deterministicRepairPasses,
      `${STATE_FILE}.deterministicRepairPasses`,
    );
    stateReviewRepairPasses = requireNonNegativeSafeInteger(
      state.reviewRepairPasses,
      `${STATE_FILE}.reviewRepairPasses`,
    );
  }
  const stateRepairPasses = requireNonNegativeSafeInteger(state.repairPasses, `${STATE_FILE}.repairPasses`);
  const stateRescoutPasses = requireNonNegativeSafeInteger(state.rescoutPasses, `${STATE_FILE}.rescoutPasses`);
  const stateReplanPasses = requireNonNegativeSafeInteger(state.replanPasses, `${STATE_FILE}.replanPasses`);
  const statePlanGatePasses = requireNonNegativeSafeInteger(state.planGatePasses, `${STATE_FILE}.planGatePasses`);
  if (
    stateDeterministicRepairPasses !== undefined &&
    stateReviewRepairPasses !== undefined &&
    stateRepairPasses !== stateDeterministicRepairPasses + stateReviewRepairPasses
  ) {
    throw new Error(
      `${STATE_FILE}.repairPasses ${stateRepairPasses} does not equal deterministicRepairPasses ${stateDeterministicRepairPasses} plus reviewRepairPasses ${stateReviewRepairPasses}`,
    );
  }
  if (stateRepairPasses !== summaryRepairPasses) {
    throw new Error(
      `conflicting evidence: ${STATE_FILE}.repairPasses ${stateRepairPasses} does not match ${RUN_SUMMARY_FILE}.repairPasses ${summaryRepairPasses}`,
    );
  }
  if (stateRescoutPasses !== summaryRescoutPasses) {
    throw new Error(
      `conflicting evidence: ${STATE_FILE}.rescoutPasses ${stateRescoutPasses} does not match ${RUN_SUMMARY_FILE}.rescoutPasses ${summaryRescoutPasses}`,
    );
  }
  if (stateReplanPasses !== summaryReplanPasses) {
    throw new Error(
      `conflicting evidence: ${STATE_FILE}.replanPasses ${stateReplanPasses} does not match ${RUN_SUMMARY_FILE}.replanPasses ${summaryReplanPasses}`,
    );
  }
  if (statePlanGatePasses !== summaryPlanGatePasses) {
    throw new Error(
      `conflicting evidence: ${STATE_FILE}.planGatePasses ${statePlanGatePasses} does not match ${RUN_SUMMARY_FILE}.planGatePasses ${summaryPlanGatePasses}`,
    );
  }

  // Persisted arrays: summary counts must equal array lengths; an absent
  // (contract-optional) array means the summary count must be zero.
  const persistedCountPairs: Array<{ stateField: string; summaryName: string; summaryCount: number }> = [
    { stateField: "checkpoints", summaryName: "checkpointCount", summaryCount: summaryCheckpointCount },
    { stateField: "workerContinuations", summaryName: "workerContinuationCount", summaryCount: summaryWorkerContinuationCount },
    { stateField: "parallelBatches", summaryName: "parallelBatchCount", summaryCount: summaryParallelBatchCount },
  ];
  for (const pair of persistedCountPairs) {
    const arrayValue = state[pair.stateField];
    if (arrayValue === undefined) {
      if (pair.summaryCount !== 0) {
        throw new Error(
          `conflicting evidence: ${RUN_SUMMARY_FILE}.${pair.summaryName} ${pair.summaryCount} but ${STATE_FILE}.${pair.stateField} is absent (absent means zero)`,
        );
      }
    } else {
      if (!Array.isArray(arrayValue)) {
        throw new Error(`${STATE_FILE}.${pair.stateField} must be an array, got ${describeType(arrayValue)}`);
      }
      if (pair.summaryCount !== arrayValue.length) {
        throw new Error(
          `conflicting evidence: ${RUN_SUMMARY_FILE}.${pair.summaryName} ${pair.summaryCount} does not match ${STATE_FILE}.${pair.stateField} length ${arrayValue.length}`,
        );
      }
    }
  }

  const stateSourceDisposition = requireObject(state.sourceDisposition, `${STATE_FILE}.sourceDisposition`);

  // 3. source-disposition.json (authoritative disposition)
  const dispositionArtifact = await readArtifactObject(runDirectory, SOURCE_DISPOSITION_FILE);
  const sourceDisposition = requireNonEmptyString(
    dispositionArtifact.disposition,
    `${SOURCE_DISPOSITION_FILE}.disposition`,
  );
  const dispositionFinalStatus = requireString(dispositionArtifact.finalStatus, `${SOURCE_DISPOSITION_FILE}.finalStatus`);
  const dispositionRunDir = requireNonEmptyString(dispositionArtifact.runDir, `${SOURCE_DISPOSITION_FILE}.runDir`);

  // 4. source-before.json (authoritative starting commit)
  const sourceBefore = await readArtifactObject(runDirectory, SOURCE_BEFORE_FILE);
  const head = requireString(sourceBefore.head, `${SOURCE_BEFORE_FILE}.head`);
  if (head.length === 0) {
    throw new Error(`${SOURCE_BEFORE_FILE}.head: run started without a commit (unborn repository); no starting provenance is substituted`);
  }
  const targetStartingCommit = head;

  // Run identity: summary id, state id, directory basename, and the
  // authoritative runDir basename must all agree (separators normalized).
  const directoryBasename = pathBasename(runDirectory);
  if (runId !== stateId) {
    throw new Error(
      `conflicting evidence: ${RUN_SUMMARY_FILE}.id ${JSON.stringify(runId)} does not match ${STATE_FILE}.id ${JSON.stringify(stateId)}`,
    );
  }
  if (runId !== directoryBasename) {
    throw new Error(
      `conflicting evidence: ${RUN_SUMMARY_FILE}.id ${JSON.stringify(runId)} does not match run directory basename ${JSON.stringify(directoryBasename)}`,
    );
  }
  const dispositionBasename = pathBasename(dispositionRunDir);
  if (dispositionBasename !== runId) {
    throw new Error(
      `conflicting evidence: ${SOURCE_DISPOSITION_FILE}.runDir basename ${JSON.stringify(dispositionBasename)} does not match run id ${JSON.stringify(runId)}`,
    );
  }

  // Completion evidence: matching valid timestamps and terminal outcomes.
  if (stateCompletedAt !== summaryCompletedAt) {
    throw new Error(
      `conflicting evidence: ${STATE_FILE}.completedAt ${JSON.stringify(stateCompletedAt)} does not match ${RUN_SUMMARY_FILE}.completedAt ${JSON.stringify(summaryCompletedAt)}`,
    );
  }
  if (stateFinalStatus !== summaryFinalStatus) {
    throw new Error(
      `conflicting evidence: ${STATE_FILE}.finalStatus ${JSON.stringify(stateFinalStatus)} does not match ${RUN_SUMMARY_FILE}.finalStatus ${JSON.stringify(summaryFinalStatus)}`,
    );
  }
  if (stateFinalReason !== summaryFinalReason) {
    throw new Error(
      `conflicting evidence: ${STATE_FILE}.finalReason does not match ${RUN_SUMMARY_FILE}.finalReason`,
    );
  }
  if (dispositionFinalStatus !== summaryFinalStatus) {
    throw new Error(
      `conflicting evidence: ${SOURCE_DISPOSITION_FILE}.finalStatus ${JSON.stringify(dispositionFinalStatus)} does not match ${RUN_SUMMARY_FILE}.finalStatus ${JSON.stringify(summaryFinalStatus)}`,
    );
  }

  // Disposition mirrors must agree with the authoritative disposition and
  // run identity.
  const summaryDispositionValue = requireString(
    summarySourceDisposition.disposition,
    `${RUN_SUMMARY_FILE}.sourceDisposition.disposition`,
  );
  if (summaryDispositionValue !== sourceDisposition) {
    throw new Error(
      `conflicting evidence: ${RUN_SUMMARY_FILE}.sourceDisposition.disposition ${JSON.stringify(summaryDispositionValue)} does not match ${SOURCE_DISPOSITION_FILE}.disposition ${JSON.stringify(sourceDisposition)}`,
    );
  }
  if (pathBasename(requireNonEmptyString(summarySourceDisposition.runDir, `${RUN_SUMMARY_FILE}.sourceDisposition.runDir`)) !== runId) {
    throw new Error(
      `conflicting evidence: ${RUN_SUMMARY_FILE}.sourceDisposition.runDir does not match run id ${JSON.stringify(runId)}`,
    );
  }
  const stateDispositionValue = requireString(stateSourceDisposition.disposition, `${STATE_FILE}.sourceDisposition.disposition`);
  if (stateDispositionValue !== sourceDisposition) {
    throw new Error(
      `conflicting evidence: ${STATE_FILE}.sourceDisposition.disposition ${JSON.stringify(stateDispositionValue)} does not match ${SOURCE_DISPOSITION_FILE}.disposition ${JSON.stringify(sourceDisposition)}`,
    );
  }
  if (pathBasename(requireNonEmptyString(stateSourceDisposition.runDir, `${STATE_FILE}.sourceDisposition.runDir`)) !== runId) {
    throw new Error(
      `conflicting evidence: ${STATE_FILE}.sourceDisposition.runDir does not match run id ${JSON.stringify(runId)}`,
    );
  }

  // Final validated record: fresh objects from the validated fields, caller
  // assertion values/ordering preserved, intervention boolean unchanged, no
  // telemetry, no scoring.
  return validateBenchmarkExecutionRecord({
    caseId,
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    factoryVersionRef,
    targetStartingCommit,
    runId,
    finalStatus: summaryFinalStatus,
    finalReason: summaryFinalReason,
    authoritativeVerificationPassed,
    assertionResults,
    humanImplementationIntervention,
    sourceDisposition,
    counters: {
      workerUnits,
      planGatePasses: summaryPlanGatePasses,
      repairPasses: summaryRepairPasses,
      rescoutPasses: summaryRescoutPasses,
      replanPasses: summaryReplanPasses,
      continuationCount: summaryWorkerContinuationCount,
      checkpointCount: summaryCheckpointCount,
      parallelBatchCount: summaryParallelBatchCount,
    },
    durationMs,
  });
}
