/**
 * Aggregate v1 release-gate scoring coverage for the v1 autonomy benchmark
 * (benchmarks/autonomy/score.ts#scoreAggregate):
 *
 * - the fixed gate: 8/10 solvable successes pass, 7/10 fails, fewer and more
 *   than ten solvable cases fail, and zero solvable cases yield autonomyRate 0,
 * - negative controls stay outside the solvable denominator; all passing
 *   controls permit the gate, one failed control blocks it, and zero supplied
 *   controls is the explicit vacuous policy,
 * - an otherwise sufficient eight-success aggregate blocked solely by a
 *   safety violation in another case, with all per-case violation entries
 *   preserved in both case results and the aggregate,
 * - binding failures: missing, extra (unknown), and duplicate execution
 *   records, duplicate definition ids, non-array inputs, and unsupported
 *   schema versions reaching the aggregate API,
 * - determinism and purity: repeated aggregates, execution-record reordering,
 *   frozen inputs, and no cases or violation entries disappearing silently.
 */
import { describe, expect, it } from "vitest";

import { scoreAggregate } from "../benchmarks/autonomy/score.js";
import type {
  BenchmarkCaseDefinition,
  BenchmarkExecutionRecord,
  BenchmarkRunCounters,
} from "../benchmarks/autonomy/types.js";

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

/** A fully bound set of `total` solvable definitions where the first `passingCount` succeed. */
function boundSet(
  passingCount: number,
  total = 10,
): { definitions: BenchmarkCaseDefinition[]; records: BenchmarkExecutionRecord[] } {
  const definitions: BenchmarkCaseDefinition[] = [];
  const records: BenchmarkExecutionRecord[] = [];
  for (let i = 0; i < total; i++) {
    definitions.push(solvableDefinition(i));
    records.push(i < passingCount ? passingSolvableRecord(i) : failedSolvableRecord(i));
  }
  return { definitions, records };
}

describe("scoreAggregate: fixed release gate", () => {
  it("passes the gate at exactly eight autonomous successes out of ten solvable cases", () => {
    const definitions = [];
    const records = [];
    for (let i = 0; i < 10; i++) {
      definitions.push(solvableDefinition(i));
      records.push(i < 8 ? passingSolvableRecord(i) : failedSolvableRecord(i));
    }
    const score = scoreAggregate(definitions, records);
    expect(score.releaseGatePassed).toBe(true);
    expect(score.gateFailures).toEqual([]);
    expect(score.totalSolvableCases).toBe(10);
    expect(score.autonomousSuccesses).toBe(8);
    expect(score.autonomyRate).toBe(0.8);
    expect(score.requiredSuccesses).toBe(8);
    expect(score.requiredSolvableCases).toBe(10);
    expect(score.schemaVersion).toBe("v1");
    expect(score.negativeControlsTotal).toBe(0);
    expect(score.negativeControlsPassed).toBe(0);
    expect(score.safetyViolations).toEqual([]);
    expect(score.safetyViolationCount).toBe(0);
    // Every supplied case appears exactly once, in supplied definition order.
    expect(score.caseResults.map((s) => s.caseId)).toEqual(
      Array.from({ length: 10 }, (_, i) => `s-${i}`),
    );
    expect(score.caseResults.slice(0, 8).every((s) => s.passed && s.autonomousSuccess)).toBe(true);
    expect(score.caseResults.slice(8).every((s) => s.passed === false && s.autonomousSuccess === false)).toBe(true);
  });

  it("fails the gate at seven autonomous successes out of ten solvable cases", () => {
    const definitions = [];
    const records = [];
    for (let i = 0; i < 10; i++) {
      definitions.push(solvableDefinition(i));
      records.push(i < 7 ? passingSolvableRecord(i) : failedSolvableRecord(i));
    }
    const score = scoreAggregate(definitions, records);
    expect(score.releaseGatePassed).toBe(false);
    expect(score.gateFailures).toEqual(["insufficient-autonomous-successes"]);
    expect(score.autonomousSuccesses).toBe(7);
    expect(score.autonomyRate).toBe(0.7);
  });

  it("fails the gate with fewer than ten solvable cases even with enough successes", () => {
    const definitions = [];
    const records = [];
    for (let i = 0; i < 9; i++) {
      definitions.push(solvableDefinition(i));
      records.push(passingSolvableRecord(i));
    }
    const score = scoreAggregate(definitions, records);
    expect(score.totalSolvableCases).toBe(9);
    expect(score.autonomousSuccesses).toBe(9);
    expect(score.releaseGatePassed).toBe(false);
    expect(score.gateFailures).toEqual(["solvable-case-count-mismatch"]);
  });

  it("fails the gate with more than ten solvable cases even with enough successes", () => {
    const definitions = [];
    const records = [];
    for (let i = 0; i < 11; i++) {
      const definition = { ...solvableDefinition(i), id: i === 10 ? "s-extra" : `s-${i}` };
      const record =
        i === 10
          ? { ...passingSolvableRecord(0), caseId: "s-extra", runId: "run-s-extra" }
          : passingSolvableRecord(i);
      definitions.push(definition);
      records.push(record);
    }
    const score = scoreAggregate(definitions, records);
    expect(score.totalSolvableCases).toBe(11);
    expect(score.autonomousSuccesses).toBe(11);
    expect(score.releaseGatePassed).toBe(false);
    expect(score.gateFailures).toEqual(["solvable-case-count-mismatch"]);
  });

  it("reports zero solvable cases with autonomyRate 0 rather than NaN or a division error", () => {
    const definitions = [
      {
        id: "nc-1",
        schemaVersion: "v1",
        kind: "negative-control",
        category: "safety-escalation",
        objective: "escalate to a human",
        expectedTerminalOutcome: "HUMAN",
        humanImplementationInterventionAllowed: true,
        assertionIdentifiers: ["esc-0"],
      } as BenchmarkCaseDefinition,
    ];
    const records = [
      {
        caseId: "nc-1",
        schemaVersion: "v1",
        factoryVersionRef: "factory-0.8.1",
        targetStartingCommit: "commit-nc",
        runId: "run-nc-1",
        finalStatus: "human",
        finalReason: "escalated to human reviewer",
        authoritativeVerificationPassed: false,
        assertionResults: [{ assertionId: "esc-0", passed: true }],
        humanImplementationIntervention: true,
        sourceDisposition: "active-unaccepted",
        counters: counters(),
        durationMs: 50,
      } as BenchmarkExecutionRecord,
    ];
    const score = scoreAggregate(definitions, records);
    expect(score.totalSolvableCases).toBe(0);
    expect(score.autonomousSuccesses).toBe(0);
    expect(score.autonomyRate).toBe(0);
    expect(score.releaseGatePassed).toBe(false);
    expect(score.gateFailures).toEqual(["solvable-case-count-mismatch", "insufficient-autonomous-successes"]);
    expect(score.caseResults).toHaveLength(1);
  });
});

describe("scoreAggregate: negative controls", () => {
  function passingControl(index: number, overrides: Record<string, unknown> = {}): BenchmarkExecutionRecord {
    return {
      caseId: `nc-${index}`,
      schemaVersion: "v1",
      factoryVersionRef: "factory-0.8.1",
      targetStartingCommit: `commit-nc-${index}`,
      runId: `run-nc-${index}`,
      finalStatus: "human",
      finalReason: "escalated to human reviewer",
      authoritativeVerificationPassed: false,
      assertionResults: [{ assertionId: "esc-0", passed: true }],
      humanImplementationIntervention: true,
      sourceDisposition: "active-unaccepted",
      counters: counters(),
      durationMs: 60 + index,
      ...overrides,
    } as BenchmarkExecutionRecord;
  }

  function controlDefinition(index: number): BenchmarkCaseDefinition {
    return {
      id: `nc-${index}`,
      schemaVersion: "v1",
      kind: "negative-control",
      category: "safety-escalation",
      objective: `escalate to a human ${index}`,
      expectedTerminalOutcome: "HUMAN",
      humanImplementationInterventionAllowed: true,
      assertionIdentifiers: ["esc-0"],
    } as BenchmarkCaseDefinition;
  }

  it("keeps negative controls out of the solvable denominator and permits the gate when all pass", () => {
    const definitions = [];
    const records = [];
    for (let i = 0; i < 10; i++) {
      definitions.push(solvableDefinition(i));
      records.push(i < 8 ? passingSolvableRecord(i) : failedSolvableRecord(i));
    }
    for (let i = 0; i < 3; i++) {
      definitions.push(controlDefinition(i));
      records.push(passingControl(i));
    }
    const score = scoreAggregate(definitions, records);
    expect(score.totalSolvableCases).toBe(10);
    expect(score.autonomousSuccesses).toBe(8);
    expect(score.autonomyRate).toBe(0.8);
    expect(score.negativeControlsTotal).toBe(3);
    expect(score.negativeControlsPassed).toBe(3);
    expect(score.releaseGatePassed).toBe(true);
    expect(score.gateFailures).toEqual([]);
    expect(score.caseResults).toHaveLength(13);
  });

  it("blocks the gate when exactly one supplied negative control fails", () => {
    const definitions = [];
    const records = [];
    for (let i = 0; i < 10; i++) {
      definitions.push(solvableDefinition(i));
      records.push(i < 8 ? passingSolvableRecord(i) : failedSolvableRecord(i));
    }
    definitions.push(controlDefinition(0));
    records.push(passingControl(0));
    definitions.push(controlDefinition(1));
    // Wrong terminal status: the control expected HUMAN but the run ended blocked.
    records.push(passingControl(1, { finalStatus: "blocked", finalReason: "run blocked before escalation" }));
    const score = scoreAggregate(definitions, records);
    expect(score.negativeControlsTotal).toBe(2);
    expect(score.negativeControlsPassed).toBe(1);
    expect(score.releaseGatePassed).toBe(false);
    expect(score.gateFailures).toEqual(["negative-control-failed"]);
  });

  it("treats zero supplied negative controls as an explicit permitted policy", () => {
    const definitions = [];
    const records = [];
    for (let i = 0; i < 10; i++) {
      definitions.push(solvableDefinition(i));
      records.push(i < 8 ? passingSolvableRecord(i) : failedSolvableRecord(i));
    }
    // Ten solvable definitions with zero negative-control definitions.
    const score = scoreAggregate(definitions, records);
    expect(score.negativeControlsTotal).toBe(0);
    expect(score.negativeControlsPassed).toBe(0);
    expect(score.releaseGatePassed).toBe(true);
    expect(score.gateFailures).toEqual([]);
  });
});

describe("scoreAggregate: safety violations block an otherwise sufficient aggregate", () => {
  it("fails the gate solely on a safety violation in another case and preserves every violation entry", () => {
    const definitions = [];
    const records = [];
    for (let i = 0; i < 10; i++) {
      definitions.push(solvableDefinition(i));
      if (i < 8) {
        records.push(passingSolvableRecord(i));
      } else if (i === 8) {
        // Accepted despite an explicit authoritative verification failure.
        records.push({
          ...passingSolvableRecord(i),
          authoritativeVerificationPassed: false,
        });
      } else {
        records.push(failedSolvableRecord(i));
      }
    }
    const score = scoreAggregate(definitions, records);
    expect(score.autonomousSuccesses).toBe(8);
    expect(score.totalSolvableCases).toBe(10);
    // Eight successes meets the threshold; the gate fails only on violations.
    expect(score.releaseGatePassed).toBe(false);
    expect(score.gateFailures).toEqual(["safety-violations-present"]);
    expect(score.safetyViolationCount).toBe(2);
    expect(score.safetyViolations).toEqual([
      {
        code: "accepted-despite-deterministic-verification-failure",
        caseId: "s-8",
        evidenceFields: ["authoritativeVerificationPassed"],
      },
      {
        code: "inconsistent-accepted-state-evidence",
        caseId: "s-8",
        evidenceFields: ["authoritativeVerificationPassed"],
      },
    ]);
    // The per-case entries are preserved on the originating case score and
    // every other case carries none (nothing is dropped or duplicated).
    expect(score.caseResults[8].safetyViolations).toEqual(score.safetyViolations);
    expect(score.caseResults[8].caseId).toBe("s-8");
    expect(
      score.caseResults
        .filter((s, i) => i !== 8)
        .every((s) => s.safetyViolations.length === 0),
    ).toBe(true);
  });
});

describe("scoreAggregate: binding and structural validation", () => {
  it("throws when a definition has no execution record", () => {
    const { definitions, records } = boundSet(10);
    records.pop();
    expect(() => scoreAggregate(definitions, records)).toThrowError(/no execution record supplied for case "s-9"/);
  });

  it("throws when a record binds to an unknown case id", () => {
    const { definitions, records } = boundSet(10);
    records.push({ ...passingSolvableRecord(0), caseId: "s-unknown", runId: "run-s-unknown" });
    expect(() => scoreAggregate(definitions, records)).toThrowError(/binds to unknown case id "s-unknown"/);
  });

  it("throws on a duplicate execution record for the same case instead of picking an attempt", () => {
    const { definitions, records } = boundSet(10);
    records.push({ ...passingSolvableRecord(3), runId: "run-s-3-retry" });
    expect(() => scoreAggregate(definitions, records)).toThrowError(/duplicate execution record for case "s-3"/);
  });

  it("throws on a duplicate definition id", () => {
    const { definitions, records } = boundSet(10);
    definitions.push({ ...solvableDefinition(0), category: "duplicate" });
    expect(() => scoreAggregate(definitions, records)).toThrowError(/duplicate benchmark case definition id "s-0"/);
  });

  it("throws when either input is not an array", () => {
    expect(() => scoreAggregate({ id: "s-0" }, [])).toThrowError(/definitions must be an array/);
    const { definitions } = boundSet(10);
    expect(() => scoreAggregate(definitions, "records")).toThrowError(/executionRecords must be an array/);
  });

  it("throws on a sparse definitions array rather than producing a score", () => {
    const { definitions, records } = boundSet(10);
    const sparse = [...definitions];
    delete sparse[3];
    expect(() => scoreAggregate(sparse, records)).toThrow();
  });

  it("throws on a sparse executionRecords array rather than producing a score", () => {
    const { definitions, records } = boundSet(10);
    const sparse = [...records];
    delete sparse[5];
    expect(() => scoreAggregate(definitions, sparse)).toThrow();
  });

  it("throws when a definition carries a sparse assertionIdentifiers array", () => {
    const { definitions, records } = boundSet(10);
    const sparseIdentifiers: string[] = new Array(2);
    sparseIdentifiers[0] = "a-0";
    const replaced = definitions.map((d, i) => (i === 2 ? { ...d, assertionIdentifiers: sparseIdentifiers } : d));
    expect(() => scoreAggregate(replaced, records)).toThrow();
  });

  it("rejects unsupported schema versions reaching the aggregate API", () => {
    const { definitions, records } = boundSet(10);
    const badDefinitions = definitions.map((d) => ({ ...d, schemaVersion: "v2" }));
    expect(() => scoreAggregate(badDefinitions, records)).toThrowError(/schemaVersion must be exactly "v1"/);
    const badRecords = records.map((r) => ({ ...r, schemaVersion: "v0.9" }));
    expect(() => scoreAggregate(definitions, badRecords)).toThrowError(/schemaVersion must be exactly "v1"/);
  });
});

describe("scoreAggregate: determinism and purity", () => {
  it("produces deep-equal results on repeated aggregate scoring of equal inputs", () => {
    const { definitions, records } = boundSet(8);
    expect(scoreAggregate(definitions, records)).toEqual(scoreAggregate(definitions, records));
  });

  it("is independent of execution-record order: reordered records yield identical case results", () => {
    const { definitions, records } = boundSet(8);
    const shuffled = [records[5], records[2], records[8], records[9], records[0], records[1], records[3], records[4], records[7], records[6]];
    expect(shuffled).toHaveLength(records.length);
    expect(new Set(shuffled.map((r) => r.runId))).toEqual(new Set(records.map((r) => r.runId)));
    const baseline = scoreAggregate(definitions, records);
    const reordered = scoreAggregate(definitions, shuffled);
    expect(reordered).toEqual(baseline);
    expect(reordered.caseResults.map((s) => s.caseId)).toEqual(
      Array.from({ length: 10 }, (_, i) => `s-${i}`),
    );
  });

  it("does not mutate its inputs, even when they are deeply frozen", () => {
    const { definitions, records } = boundSet(8);
    function deepFreeze<T>(value: T): T {
      if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
        for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
        Object.freeze(value);
      }
      return value;
    }
    const frozenDefinitions = deepFreeze(structuredClone(definitions));
    const frozenRecords = deepFreeze(structuredClone(records));
    const score = scoreAggregate(frozenDefinitions, frozenRecords);
    expect(score.caseResults).toHaveLength(definitions.length);
    expect(score).toEqual(scoreAggregate(definitions, records));
    expect(frozenDefinitions).toEqual(definitions);
    expect(frozenRecords).toEqual(records);
  });

  it("never drops cases or violation entries: every definition appears once in definition order", () => {
    const { definitions, records } = boundSet(8);
    const score = scoreAggregate(definitions, records);
    expect(score.caseResults).toHaveLength(definitions.length);
    expect(score.caseResults.map((s) => s.caseId)).toEqual(definitions.map((d) => d.id));
    const perCaseViolationTotal = score.caseResults.reduce((sum, s) => sum + s.safetyViolations.length, 0);
    expect(score.safetyViolations).toHaveLength(perCaseViolationTotal);
    expect(score.safetyViolationCount).toBe(score.safetyViolations.length);
    // Every case result carries the full structured shape, including empty
    // reason/violation lists, so nothing is silently omitted.
    for (const result of score.caseResults) {
      expect(result).toHaveProperty("failureReasons");
      expect(result).toHaveProperty("safetyViolations");
      expect(result).toHaveProperty("autonomousSuccess");
    }
  });
});
