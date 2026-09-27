/**
 * Focused coverage for the offline v0.9 run-artifact reader
 * (benchmarks/autonomy/run-artifacts.ts), `ingestRunArtifacts`:
 *
 * - a realistic completed-run fixture (built in a temporary directory and
 *   cleaned up reliably) yields the complete expected record with every
 *   counter mapping, the persisted duration, starting commit, and provenance;
 *   the fixture includes two worker reports for one continued unit and a
 *   stale initial `verification.json` (false) while the final
 *   `state.json.verification.passed` is true, to catch unit overcounting and
 *   stale-verification selection,
 * - an absent final `state.json.verification` is rejected even when the
 *   initial `verification.json` is present (no fallback),
 * - an absent `source-disposition.json` is rejected rather than substituted
 *   from the summary/state mirrors,
 * - conflicting run identity between two required artifacts is rejected with
 *   the conflicting evidence named,
 * - malformed JSON in one required artifact is rejected naming that artifact,
 * - ingestion is deterministic and non-mutating: frozen caller metadata and
 *   assertion objects survive, artifact bytes are unchanged, two ingests are
 *   deep-equal, and the returned record is built from fresh objects (explicit
 *   intervention and a failing assertion are preserved, never inferred or
 *   scored).
 *
 * No factory runs, Git setup, model execution, scoring, or committed fixture
 * corpus: all fixtures are generated inside the tests and removed afterward.
 */
import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ingestRunArtifacts } from "../benchmarks/autonomy/run-artifacts.js";
import type { IngestRunArtifactsMetadata } from "../benchmarks/autonomy/run-artifacts.js";
import type { BenchmarkExecutionRecord } from "../benchmarks/autonomy/types.js";

const RUN_ID = "run-abc123";
const HEAD = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b";
const COMPLETED_AT = "2025-01-15T12:30:00.000Z";
const FINAL_REASON = "all verification commands passed";
const SOURCE_DISPOSITION = "accepted-in-place";

/** Temp roots created by this suite, removed reliably in `afterEach`. */
const tempRoots: string[] = [];

/**
 * The four required artifacts (plus the stale initial `verification.json`,
 * which must never be consulted) for a completed v0.9 run. Deliberately
 * realistic: two worker reports for one continued unit, non-zero mirrored
 * counters with `repairPasses = deterministic + review`, persisted checkpoint
 * and continuation arrays matching the summary counts, an absent (optional)
 * `parallelBatches` array with a zero summary count, a Windows-style
 * `runDir` in the authoritative disposition, and a POSIX-style `runDir` in a
 * mirror.
 */
function baseArtifacts(): Record<string, Record<string, unknown> | string> {
  return {
    "run-summary.json": {
      id: RUN_ID,
      finalStatus: "accepted",
      finalReason: FINAL_REASON,
      completedAt: COMPLETED_AT,
      repairPasses: 2,
      rescoutPasses: 1,
      replanPasses: 0,
      planGatePasses: 1,
      workerContinuationCount: 2,
      checkpointCount: 1,
      parallelBatchCount: 0,
      runWallClockDurationMs: 123456,
      sourceDisposition: {
        disposition: SOURCE_DISPOSITION,
        runDir: `C:\\factory\\runs\\${RUN_ID}`,
      },
    },
    "state.json": {
      id: RUN_ID,
      finalStatus: "accepted",
      finalReason: FINAL_REASON,
      completedAt: COMPLETED_AT,
      verification: { passed: true, command: "npm test" },
      workers: [
        { unitId: "u-core" },
        { unitId: "u-core" }, // implementation continuation report for the same unit
        { unitId: "u-tests" },
      ],
      deterministicRepairPasses: 1,
      reviewRepairPasses: 1,
      repairPasses: 2,
      rescoutPasses: 1,
      replanPasses: 0,
      planGatePasses: 1,
      checkpoints: [{ id: "cp-1", at: "2025-01-15T12:00:00.000Z" }],
      workerContinuations: [
        { unitId: "u-core", at: "2025-01-15T11:50:00.000Z" },
        { unitId: "u-core", at: "2025-01-15T11:55:00.000Z" },
      ],
      // `parallelBatches` deliberately absent: contract-optional, count zero.
      sourceDisposition: {
        disposition: SOURCE_DISPOSITION,
        runDir: `/srv/runs/${RUN_ID}`,
      },
    },
    "source-disposition.json": {
      disposition: SOURCE_DISPOSITION,
      finalStatus: "accepted",
      runDir: `C:\\factory\\runs\\${RUN_ID}\\`,
    },
    "source-before.json": {
      head: HEAD,
      capturedAt: "2025-01-15T11:00:00.000Z",
    },
    // Stale initial verification, present to prove it is not a fallback.
    "verification.json": {
      passed: false,
      command: "npm test",
    },
  };
}

async function writeRunDirectory(artifacts: Record<string, Record<string, unknown> | string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "run-artifacts-test-"));
  tempRoots.push(root);
  const runDirectory = join(root, RUN_ID);
  await mkdir(runDirectory, { recursive: true });
  for (const [fileName, value] of Object.entries(artifacts)) {
    const content = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    await writeFile(join(runDirectory, fileName), content, "utf8");
  }
  return runDirectory;
}

async function readAllArtifactBytes(runDirectory: string): Promise<Record<string, string>> {
  const files = ["run-summary.json", "state.json", "source-disposition.json", "source-before.json", "verification.json"];
  const bytes: Record<string, string> = {};
  for (const fileName of files) {
    const filePath = join(runDirectory, fileName);
    try {
      bytes[fileName] = await readFile(filePath, "utf8");
    } catch (error) {
      bytes[fileName] = `absent (${(error as NodeJS.ErrnoException | undefined)?.code ?? String(error)})`;
    }
  }
  return bytes;
}

function makeMetadata(): IngestRunArtifactsMetadata {
  return {
    caseId: "case-42",
    factoryVersionRef: "factory-v0.9.0-rc1+sha.9f86d08",
    humanImplementationIntervention: false,
    assertionResults: [
      { assertionId: "files-match-scope", passed: true },
      { assertionId: "no-telemetry-leak", passed: true },
    ],
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

afterEach(async () => {
  const roots = tempRoots.splice(0);
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
});

it("ingests a valid completed v0.9 run into the complete expected record", async () => {
  const runDirectory = await writeRunDirectory(baseArtifacts());

  const record = await ingestRunArtifacts(runDirectory, makeMetadata());

  const expected: BenchmarkExecutionRecord = {
    caseId: "case-42",
    schemaVersion: "v1",
    factoryVersionRef: "factory-v0.9.0-rc1+sha.9f86d08",
    targetStartingCommit: HEAD,
    runId: RUN_ID,
    finalStatus: "accepted",
    finalReason: FINAL_REASON,
    authoritativeVerificationPassed: true,
    assertionResults: [
      { assertionId: "files-match-scope", passed: true },
      { assertionId: "no-telemetry-leak", passed: true },
    ],
    humanImplementationIntervention: false,
    sourceDisposition: SOURCE_DISPOSITION,
    counters: {
      workerUnits: 2, // distinct unitIds: the continued u-core unit counts once
      planGatePasses: 1,
      repairPasses: 2,
      rescoutPasses: 1,
      replanPasses: 0,
      continuationCount: 2, // mapped from workerContinuationCount
      checkpointCount: 1,
      parallelBatchCount: 0, // absent optional array means zero
    },
    durationMs: 123456, // mapped from runWallClockDurationMs, never recomputed
  };
  expect(record).toEqual(expected);
});

it("rejects an absent final verification even when the initial verification.json exists", async () => {
  const artifacts = baseArtifacts();
  const state = artifacts["state.json"] as Record<string, unknown>;
  delete state.verification;
  // The stale initial verification.json is deliberately retained: it must not
  // be substituted for the missing final result.
  const runDirectory = await writeRunDirectory(artifacts);

  const rejection = ingestRunArtifacts(runDirectory, makeMetadata());

  await expect(rejection).rejects.toThrow(/state\.json\.verification/);
  await expect(rejection).rejects.toThrow(/verification\.json \/ verification-after-\*\.json are not fallbacks/);
});

it("rejects a missing source-disposition.json rather than falling back to mirrored copies", async () => {
  const artifacts = baseArtifacts();
  delete artifacts["source-disposition.json"];
  // The summary and state sourceDisposition mirrors are deliberately retained:
  // they must not be used as a substitute for the authoritative artifact.
  const runDirectory = await writeRunDirectory(artifacts);

  await expect(ingestRunArtifacts(runDirectory, makeMetadata())).rejects.toThrow(/source-disposition\.json/);
});

it("rejects mismatched run identity between required artifacts and names the conflicting evidence", async () => {
  const artifacts = baseArtifacts();
  const state = artifacts["state.json"] as Record<string, unknown>;
  state.id = "run-zzz999";
  const runDirectory = await writeRunDirectory(artifacts);

  const rejection = ingestRunArtifacts(runDirectory, makeMetadata());

  await expect(rejection).rejects.toThrow(/conflicting evidence/);
  await expect(rejection).rejects.toThrow(/run-summary\.json\.id/);
  await expect(rejection).rejects.toThrow(/state\.json\.id/);
  await expect(rejection).rejects.toThrow(/"run-zzz999"/);
});

it("rejects malformed JSON in one required artifact naming that artifact", async () => {
  const artifacts = baseArtifacts();
  artifacts["source-before.json"] = "{ this is not valid JSON";
  const runDirectory = await writeRunDirectory(artifacts);

  await expect(ingestRunArtifacts(runDirectory, makeMetadata())).rejects.toThrow(/source-before\.json: malformed JSON/);
});

it("is deterministic and non-mutating: equal records, fresh objects, unchanged inputs and artifact bytes", async () => {
  const metadata: IngestRunArtifactsMetadata = {
    caseId: "case-42",
    factoryVersionRef: "factory-v0.9.0-rc1+sha.9f86d08",
    // Explicit intervention and a failing assertion: preserved, never
    // inferred or scored by ingestion.
    humanImplementationIntervention: true,
    assertionResults: [
      { assertionId: "files-match-scope", passed: true },
      { assertionId: "no-telemetry-leak", passed: false },
    ],
  };
  const frozen = deepFreeze(metadata);
  const metadataSnapshot = JSON.parse(JSON.stringify(metadata));
  const runDirectory = await writeRunDirectory(baseArtifacts());
  const bytesBefore = await readAllArtifactBytes(runDirectory);

  const recordA = await ingestRunArtifacts(runDirectory, frozen);
  const recordB = await ingestRunArtifacts(runDirectory, frozen);

  // Determinism: two ingests produce deep-equal records that preserve the
  // explicit intervention and the failing assertion in declared order.
  expect(recordA).toEqual({
    caseId: "case-42",
    schemaVersion: "v1",
    factoryVersionRef: "factory-v0.9.0-rc1+sha.9f86d08",
    targetStartingCommit: HEAD,
    runId: RUN_ID,
    finalStatus: "accepted",
    finalReason: FINAL_REASON,
    authoritativeVerificationPassed: true,
    assertionResults: [
      { assertionId: "files-match-scope", passed: true },
      { assertionId: "no-telemetry-leak", passed: false },
    ],
    humanImplementationIntervention: true,
    sourceDisposition: SOURCE_DISPOSITION,
    counters: {
      workerUnits: 2,
      planGatePasses: 1,
      repairPasses: 2,
      rescoutPasses: 1,
      replanPasses: 0,
      continuationCount: 2,
      checkpointCount: 1,
      parallelBatchCount: 0,
    },
    durationMs: 123456,
  });
  expect(recordB).toEqual(recordA);

  // Fresh nested output objects, not the caller's.
  expect(recordA).not.toBe(recordB);
  expect(recordA.counters).not.toBe(recordB.counters);
  expect(recordA.assertionResults).not.toBe(recordB.assertionResults);
  expect(recordA.assertionResults).not.toBe(frozen.assertionResults);
  for (let i = 0; i < recordA.assertionResults.length; i++) {
    expect(recordA.assertionResults[i]).not.toBe(frozen.assertionResults[i]);
  }

  // Caller inputs unchanged (frozen metadata survives ingestion untouched).
  expect(metadata).toEqual(metadataSnapshot);
  expect(metadata).toBe(frozen);
  expect(Object.isFrozen(metadata.assertionResults)).toBe(true);

  // Artifacts are only read: every file's bytes are unchanged.
  expect(await readAllArtifactBytes(runDirectory)).toEqual(bytesBefore);
});
