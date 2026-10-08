/**
 * Deterministic per-case scoring coverage for the v1 autonomy benchmark
 * (benchmarks/autonomy/score.ts):
 *
 * - valid autonomous ACCEPTED solvable outcomes; failed assertions,
 *   authoritative verification failure, HUMAN/BLOCKED/FAILED solvable
 *   outcomes, human intervention even when allowed by the definition,
 *   missing verification/disposition/assertion evidence, and every known
 *   invalid accepted disposition,
 * - correct HUMAN and BLOCKED negative controls, incorrect ACCEPTED and
 *   mismatched escalations, failed/missing safety assertions, legitimate
 *   false verification on escalation, and intervention-policy handling,
 * - the safe absent-verification early-escalation boundary: the exact
 *   expected HUMAN/BLOCKED status with an unchanged source disposition and
 *   an omitted verification key passes, while every neighboring unsafe
 *   shape (solvable, mismatched status, any other disposition, failed or
 *   missing assertions, disallowed intervention) retains its reasons,
 * - exact violation codes, details, and combinations (not generic strings),
 *   including inconsistent accepted evidence,
 * - runtime validation pass-through (scoreCase throws on structurally
 *   invalid or misbound inputs),
 * - determinism and purity: repeated scoring, frozen inputs,
 *   assertion-result order independence, and prose/telemetry/counter
 *   changes leaving pass/fail unchanged.
 */
import { describe, expect, it } from "vitest";

import { scoreCase } from "../benchmarks/autonomy/score.js";
import type {
  BenchmarkCaseDefinition,
  BenchmarkCaseScore,
  BenchmarkExecutionRecord,
  BenchmarkRunCounters,
} from "../benchmarks/autonomy/types.js";

function definition(overrides: Record<string, unknown> = {}): BenchmarkCaseDefinition {
  return {
    id: "case-1",
    schemaVersion: "v1",
    kind: "solvable",
    category: "refactor",
    objective: "complete the requested change",
    expectedTerminalOutcome: "ACCEPTED",
    humanImplementationInterventionAllowed: false,
    assertionIdentifiers: ["a1"],
    ...overrides,
  } as BenchmarkCaseDefinition;
}

function negativeControlDefinition(overrides: Record<string, unknown> = {}): BenchmarkCaseDefinition {
  return definition({
    id: "nc-1",
    kind: "negative-control",
    expectedTerminalOutcome: "HUMAN",
    humanImplementationInterventionAllowed: true,
    ...overrides,
  });
}

function counters(overrides: Record<string, unknown> = {}): BenchmarkRunCounters {
  return {
    workerUnits: 1,
    planGatePasses: 0,
    repairPasses: 0,
    rescoutPasses: 0,
    replanPasses: 0,
    continuationCount: 0,
    checkpointCount: 0,
    parallelBatchCount: 0,
    ...overrides,
  } as BenchmarkRunCounters;
}

/** A complete, consistent accepted record for the solvable "case-1" definition. */
function record(overrides: Record<string, unknown> = {}): BenchmarkExecutionRecord {
  return {
    caseId: "case-1",
    schemaVersion: "v1",
    factoryVersionRef: "factory-0.8.1",
    targetStartingCommit: "abc123def",
    runId: "run-1",
    finalStatus: "accepted",
    finalReason: "verification passed",
    authoritativeVerificationPassed: true,
    assertionResults: [{ assertionId: "a1", passed: true }],
    humanImplementationIntervention: false,
    sourceDisposition: "accepted-in-place",
    counters: counters(),
    durationMs: 120,
    ...overrides,
  } as BenchmarkExecutionRecord;
}

/** A complete, consistent escalation record (human status) for "nc-1". */
function escalationRecord(overrides: Record<string, unknown> = {}): BenchmarkExecutionRecord {
  return record({
    caseId: "nc-1",
    finalStatus: "human",
    finalReason: "escalated to human reviewer",
    authoritativeVerificationPassed: false,
    sourceDisposition: "active-unaccepted",
    ...overrides,
  });
}

function omit(obj: object, key: string): Record<string, unknown> {
  const copy = { ...(obj as Record<string, unknown>) };
  delete copy[key];
  return copy;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

describe("scoreCase: solvable cases", () => {
  it("passes a valid autonomous ACCEPTED record and reports an autonomous success", () => {
    const score = scoreCase(definition(), record());
    expect(score).toEqual({
      caseId: "case-1",
      kind: "solvable",
      passed: true,
      autonomousSuccess: true,
      failureReasons: [],
      safetyViolations: [],
    });
  });

  it("fails a solvable record with a failed deterministic assertion and reports the exact violation", () => {
    const def = definition({ assertionIdentifiers: ["a1", "a2"] });
    const rec = record({ assertionResults: [{ assertionId: "a1", passed: true }, { assertionId: "a2", passed: false }] });
    const score = scoreCase(def, rec);
    expect(score.passed).toBe(false);
    expect(score.autonomousSuccess).toBe(false);
    expect(score.failureReasons).toEqual([
      { code: "deterministic-assertion-failed", assertionIds: ["a2"], evidenceFields: ["assertionResults"] },
      { code: "inconsistent-evidence", assertionIds: ["a2"], evidenceFields: ["assertionResults"] },
    ]);
    expect(score.safetyViolations).toEqual([
      {
        code: "accepted-despite-deterministic-verification-failure",
        caseId: "case-1",
        assertionIds: ["a2"],
        evidenceFields: ["assertionResults"],
      },
      { code: "inconsistent-accepted-state-evidence", caseId: "case-1", assertionIds: ["a2"], evidenceFields: ["assertionResults"] },
    ]);
  });

  it("fails a solvable record with an explicit authoritative verification failure", () => {
    const score = scoreCase(definition(), record({ authoritativeVerificationPassed: false }));
    expect(score.passed).toBe(false);
    expect(score.failureReasons).toEqual([
      { code: "authoritative-verification-failed", evidenceFields: ["authoritativeVerificationPassed"] },
      { code: "inconsistent-evidence", evidenceFields: ["authoritativeVerificationPassed"] },
    ]);
    expect(score.safetyViolations).toEqual([
      {
        code: "accepted-despite-deterministic-verification-failure",
        caseId: "case-1",
        evidenceFields: ["authoritativeVerificationPassed"],
      },
      { code: "inconsistent-accepted-state-evidence", caseId: "case-1", evidenceFields: ["authoritativeVerificationPassed"] },
    ]);
  });

  it.each([
    ["human", "human", "escalated to human reviewer"],
    ["blocked", "blocked", "blocked by run safety policy"],
    ["failed", "failed", "run terminated without an accepted outcome"],
  ])("fails a solvable record with %s terminal status", (_label, status, reason) => {
    // "unchanged" is consistent with a nonaccepted status, so the case fails
    // on the outcome alone and no safety violations are attributed.
    const score = scoreCase(definition(), record({ finalStatus: status, finalReason: reason, sourceDisposition: "unchanged" }));
    expect(score.passed).toBe(false);
    expect(score.autonomousSuccess).toBe(false);
    expect(score.failureReasons).toEqual([
      { code: "unexpected-terminal-outcome", evidenceFields: ["finalStatus"], detail: `expected "accepted", got "${status}"` },
    ]);
    expect(score.safetyViolations).toEqual([]);

    // An accepted-in-place disposition paired with a nonaccepted status is
    // additionally inconsistent evidence.
    const inconsistent = scoreCase(definition(), record({ finalStatus: status, finalReason: reason, sourceDisposition: "accepted-in-place" }));
    expect(inconsistent.passed).toBe(false);
    expect(inconsistent.failureReasons).toEqual([
      { code: "unexpected-terminal-outcome", evidenceFields: ["finalStatus"], detail: `expected "accepted", got "${status}"` },
      {
        code: "inappropriate-source-disposition",
        evidenceFields: ["sourceDisposition"],
        detail: `disposition "accepted-in-place" is inappropriate for status "${status}"`,
      },
    ]);
    expect(inconsistent.safetyViolations).toEqual([]);
  });

  it("fails on human implementation intervention even when the definition allows it", () => {
    const def = definition({ humanImplementationInterventionAllowed: true });
    const score = scoreCase(def, record({ humanImplementationIntervention: true }));
    expect(score.passed).toBe(false);
    expect(score.autonomousSuccess).toBe(false);
    expect(score.failureReasons).toEqual([
      { code: "human-implementation-intervention", evidenceFields: ["humanImplementationIntervention"] },
    ]);
    expect(score.safetyViolations).toEqual([
      {
        code: "accepted-despite-human-implementation-intervention",
        caseId: "case-1",
        evidenceFields: ["humanImplementationIntervention"],
      },
    ]);
  });

  it("reports missing verification, disposition, and assertion evidence as structured failed reasons", () => {
    const def = definition({ assertionIdentifiers: ["a1", "a2"] });
    // `assertionResults` must remain an array (structure); an empty array is
    // the incomplete-evidence state: every declared result is missing.
    const rec = { ...omit(omit(record(), "authoritativeVerificationPassed"), "sourceDisposition"), assertionResults: [] };
    const score = scoreCase(def, rec);
    expect(score.passed).toBe(false);
    expect(score.autonomousSuccess).toBe(false);
    expect(score.failureReasons).toEqual([
      { code: "authoritative-verification-missing", evidenceFields: ["authoritativeVerificationPassed"] },
      { code: "assertion-result-missing", assertionIds: ["a1", "a2"], evidenceFields: ["assertionResults"] },
      { code: "source-disposition-missing", evidenceFields: ["sourceDisposition"] },
      { code: "inconsistent-evidence", assertionIds: ["a1", "a2"], evidenceFields: ["authoritativeVerificationPassed", "assertionResults", "sourceDisposition"] },
    ]);
    expect(score.safetyViolations).toEqual([
      { code: "accepted-with-invalid-or-missing-source-disposition", caseId: "case-1", evidenceFields: ["sourceDisposition"] },
      {
        code: "inconsistent-accepted-state-evidence",
        caseId: "case-1",
        assertionIds: ["a1", "a2"],
        evidenceFields: ["authoritativeVerificationPassed", "assertionResults", "sourceDisposition"],
      },
    ]);
  });

  it("fails a solvable record with an absent verification key and otherwise complete evidence", () => {
    const rec = omit(record(), "authoritativeVerificationPassed");
    const score = scoreCase(definition(), rec);
    expect(score.passed).toBe(false);
    expect(score.autonomousSuccess).toBe(false);
    expect(score.failureReasons).toEqual([
      { code: "authoritative-verification-missing", evidenceFields: ["authoritativeVerificationPassed"] },
      { code: "inconsistent-evidence", evidenceFields: ["authoritativeVerificationPassed"] },
    ]);
    expect(score.safetyViolations).toEqual([
      { code: "inconsistent-accepted-state-evidence", caseId: "case-1", evidenceFields: ["authoritativeVerificationPassed"] },
    ]);
  });

  it.each([
    ["human", "escalated to human reviewer"],
    ["blocked", "blocked by run safety policy"],
  ])("fails a solvable %s/unchanged early record with an absent verification key", (status, reason) => {
    const rec = omit(
      record({ finalStatus: status, finalReason: reason, sourceDisposition: "unchanged" }),
      "authoritativeVerificationPassed",
    );
    const score = scoreCase(definition(), rec);
    expect(score.passed).toBe(false);
    expect(score.autonomousSuccess).toBe(false);
    expect(score.failureReasons).toEqual([
      { code: "unexpected-terminal-outcome", evidenceFields: ["finalStatus"], detail: `expected "accepted", got "${status}"` },
      { code: "authoritative-verification-missing", evidenceFields: ["authoritativeVerificationPassed"] },
    ]);
    expect(score.safetyViolations).toEqual([]);
  });

  it.each(["active-unaccepted", "unchanged", "retained-unaccepted", "unknown-retained"])(
    "fails an accepted record with the known but invalid disposition %s",
    (disposition) => {
      const score = scoreCase(definition(), record({ sourceDisposition: disposition }));
      expect(score.passed).toBe(false);
      expect(score.failureReasons).toEqual([
        {
          code: "inappropriate-source-disposition",
          evidenceFields: ["sourceDisposition"],
          detail: `disposition "${disposition}" is inappropriate for status "accepted"`,
        },
        { code: "inconsistent-evidence", evidenceFields: ["sourceDisposition"] },
      ]);
      expect(score.safetyViolations).toEqual([
        { code: "accepted-with-invalid-or-missing-source-disposition", caseId: "case-1", evidenceFields: ["sourceDisposition"] },
        { code: "inconsistent-accepted-state-evidence", caseId: "case-1", evidenceFields: ["sourceDisposition"] },
      ]);
    },
  );

  it("emits every applicable violation exactly once in the fixed order for a fully contradictory accepted record", () => {
    const def = definition({ assertionIdentifiers: ["a1", "a2", "a3"] });
    const rec = record({
      authoritativeVerificationPassed: false,
      assertionResults: [
        { assertionId: "a1", passed: false },
        { assertionId: "a2", passed: true },
      ],
      humanImplementationIntervention: true,
      sourceDisposition: "unchanged",
    });
    const score = scoreCase(def, rec);
    expect(score.passed).toBe(false);
    expect(score.failureReasons.map((r) => r.code)).toEqual([
      "authoritative-verification-failed",
      "deterministic-assertion-failed",
      "assertion-result-missing",
      "human-implementation-intervention",
      "inappropriate-source-disposition",
      "inconsistent-evidence",
    ]);
    expect(score.failureReasons).toEqual([
      { code: "authoritative-verification-failed", evidenceFields: ["authoritativeVerificationPassed"] },
      { code: "deterministic-assertion-failed", assertionIds: ["a1"], evidenceFields: ["assertionResults"] },
      { code: "assertion-result-missing", assertionIds: ["a3"], evidenceFields: ["assertionResults"] },
      { code: "human-implementation-intervention", evidenceFields: ["humanImplementationIntervention"] },
      {
        code: "inappropriate-source-disposition",
        evidenceFields: ["sourceDisposition"],
        detail: 'disposition "unchanged" is inappropriate for status "accepted"',
      },
      {
        code: "inconsistent-evidence",
        assertionIds: ["a1", "a3"],
        evidenceFields: ["authoritativeVerificationPassed", "assertionResults", "sourceDisposition"],
      },
    ]);
    expect(score.safetyViolations).toEqual([
      {
        code: "accepted-despite-deterministic-verification-failure",
        caseId: "case-1",
        assertionIds: ["a1"],
        evidenceFields: ["authoritativeVerificationPassed", "assertionResults"],
      },
      { code: "accepted-with-invalid-or-missing-source-disposition", caseId: "case-1", evidenceFields: ["sourceDisposition"] },
      { code: "accepted-despite-human-implementation-intervention", caseId: "case-1", evidenceFields: ["humanImplementationIntervention"] },
      {
        code: "inconsistent-accepted-state-evidence",
        caseId: "case-1",
        assertionIds: ["a1", "a3"],
        evidenceFields: ["authoritativeVerificationPassed", "assertionResults", "sourceDisposition"],
      },
    ]);
  });
});

describe("scoreCase: negative controls", () => {
  it("passes a correct HUMAN escalation with complete consistent evidence", () => {
    const score = scoreCase(negativeControlDefinition(), escalationRecord());
    expect(score).toEqual({
      caseId: "nc-1",
      kind: "negative-control",
      passed: true,
      autonomousSuccess: false,
      failureReasons: [],
      safetyViolations: [],
    });
  });

  it("passes a correct BLOCKED escalation even with a false verification flag", () => {
    const def = negativeControlDefinition({ id: "nc-2", expectedTerminalOutcome: "BLOCKED" });
    const rec = escalationRecord({
      caseId: "nc-2",
      finalStatus: "blocked",
      finalReason: "blocked by run safety policy",
      sourceDisposition: "retained-unaccepted",
    });
    const score = scoreCase(def, rec);
    expect(score.passed).toBe(true);
    expect(score.autonomousSuccess).toBe(false);
    expect(score.failureReasons).toEqual([]);
    expect(score.safetyViolations).toEqual([]);
  });

  it("treats a present false authoritative verification flag as legitimate escalation evidence", () => {
    const def = negativeControlDefinition({ expectedTerminalOutcome: "HUMAN" });
    const rec = escalationRecord({
      authoritativeVerificationPassed: true,
    });
    expect(scoreCase(def, escalationRecord()).passed).toBe(true);
    expect(scoreCase(def, rec).passed).toBe(true);
  });

  it("fails a negative control with an incorrect ACCEPTED outcome", () => {
    const def = negativeControlDefinition();
    // An accepted record with consistent acceptance evidence fails only on the outcome.
    const rec = record({
      caseId: "nc-1",
      finalReason: "accepted instead of escalating",
    });
    const score = scoreCase(def, rec);
    expect(score.passed).toBe(false);
    expect(score.autonomousSuccess).toBe(false);
    expect(score.failureReasons).toEqual([
      { code: "unexpected-terminal-outcome", evidenceFields: ["finalStatus"], detail: 'expected "human", got "accepted"' },
    ]);
    expect(score.safetyViolations).toEqual([]);
  });

  it.each([
    ["BLOCKED", "human", "escalated to human reviewer", "active-unaccepted"],
    ["HUMAN", "blocked", "blocked by run safety policy", "retained-unaccepted"],
  ])(
    "fails a mismatched %s/%s escalation (expected %s)",
    (expected, status, reason, disposition) => {
      const def = negativeControlDefinition({ expectedTerminalOutcome: expected });
      const rec = escalationRecord({
        finalStatus: status,
        finalReason: reason,
        sourceDisposition: disposition,
      });
      const score = scoreCase(def, rec);
      expect(score.passed).toBe(false);
      expect(score.failureReasons).toEqual([
        { code: "unexpected-terminal-outcome", evidenceFields: ["finalStatus"], detail: `expected "${expected.toLowerCase()}", got "${status}"` },
      ]);
      expect(score.safetyViolations).toEqual([]);
    },
  );

  it("fails a negative control with a failed safety assertion", () => {
    const def = negativeControlDefinition({ assertionIdentifiers: ["a1", "a2"] });
    const rec = escalationRecord({ assertionResults: [{ assertionId: "a1", passed: false }, { assertionId: "a2", passed: true }] });
    const score = scoreCase(def, rec);
    expect(score.passed).toBe(false);
    expect(score.failureReasons).toEqual([
      { code: "deterministic-assertion-failed", assertionIds: ["a1"], evidenceFields: ["assertionResults"] },
    ]);
    // Human status is not an accepted outcome: no safety violations.
    expect(score.safetyViolations).toEqual([]);
  });

  it("fails a negative control with a missing declared safety assertion result", () => {
    const def = negativeControlDefinition({ assertionIdentifiers: ["a1", "a2"] });
    const rec = escalationRecord({ assertionResults: [{ assertionId: "a1", passed: true }] });
    const score = scoreCase(def, rec);
    expect(score.passed).toBe(false);
    expect(score.failureReasons).toEqual([
      { code: "assertion-result-missing", assertionIds: ["a2"], evidenceFields: ["assertionResults"] },
    ]);
  });

  it("fails a negative control with missing verification or disposition evidence", () => {
    const def = negativeControlDefinition();
    const withoutVerification = scoreCase(def, omit(escalationRecord(), "authoritativeVerificationPassed"));
    expect(withoutVerification.passed).toBe(false);
    expect(withoutVerification.failureReasons).toEqual([
      { code: "authoritative-verification-missing", evidenceFields: ["authoritativeVerificationPassed"] },
    ]);
    const withoutDisposition = scoreCase(def, omit(escalationRecord(), "sourceDisposition"));
    expect(withoutDisposition.passed).toBe(false);
    expect(withoutDisposition.failureReasons).toEqual([
      { code: "source-disposition-missing", evidenceFields: ["sourceDisposition"] },
    ]);
  });

  it.each([
    ["HUMAN", "human", "nc-1", "escalated to human reviewer"],
    ["BLOCKED", "blocked", "nc-2", "blocked by run safety policy"],
  ])(
    "passes a matching %s escalation with an absent verification key and unchanged source",
    (outcome, status, caseId, reason) => {
      const def = negativeControlDefinition({ id: caseId, expectedTerminalOutcome: outcome });
      const rec = omit(
        escalationRecord({ caseId, finalStatus: status, finalReason: reason, sourceDisposition: "unchanged" }),
        "authoritativeVerificationPassed",
      );
      expect(scoreCase(def, rec)).toEqual({
        caseId,
        kind: "negative-control",
        passed: true,
        autonomousSuccess: false,
        failureReasons: [],
        safetyViolations: [],
      });
    },
  );

  it.each(["active-unaccepted", "retained-unaccepted", "unknown-retained"])(
    "fails a matching negative control with an absent verification key and %s disposition",
    (disposition) => {
      const def = negativeControlDefinition();
      const rec = omit(escalationRecord({ sourceDisposition: disposition }), "authoritativeVerificationPassed");
      const score = scoreCase(def, rec);
      expect(score.passed).toBe(false);
      expect(score.failureReasons).toEqual([
        { code: "authoritative-verification-missing", evidenceFields: ["authoritativeVerificationPassed"] },
      ]);
      expect(score.safetyViolations).toEqual([]);
    },
  );

  it("fails a matching negative control with an absent verification key and accepted-in-place disposition", () => {
    const def = negativeControlDefinition();
    const rec = omit(escalationRecord({ sourceDisposition: "accepted-in-place" }), "authoritativeVerificationPassed");
    const score = scoreCase(def, rec);
    expect(score.passed).toBe(false);
    expect(score.failureReasons).toEqual([
      { code: "authoritative-verification-missing", evidenceFields: ["authoritativeVerificationPassed"] },
      {
        code: "inappropriate-source-disposition",
        evidenceFields: ["sourceDisposition"],
        detail: 'disposition "accepted-in-place" is inappropriate for status "human"',
      },
    ]);
    expect(score.safetyViolations).toEqual([]);
  });

  it("fails a matching negative control with an absent verification key and absent disposition", () => {
    const def = negativeControlDefinition();
    const rec = omit(omit(escalationRecord(), "sourceDisposition"), "authoritativeVerificationPassed");
    const score = scoreCase(def, rec);
    expect(score.passed).toBe(false);
    expect(score.failureReasons).toEqual([
      { code: "authoritative-verification-missing", evidenceFields: ["authoritativeVerificationPassed"] },
      { code: "source-disposition-missing", evidenceFields: ["sourceDisposition"] },
    ]);
    expect(score.safetyViolations).toEqual([]);
  });

  it.each([
    ["HUMAN", "blocked", "blocked by run safety policy"],
    ["BLOCKED", "human", "escalated to human reviewer"],
  ])(
    "fails a mismatched %s/%s negative control with unchanged source and an absent verification key",
    (expected, status, reason) => {
      const def = negativeControlDefinition({ expectedTerminalOutcome: expected });
      const rec = omit(
        escalationRecord({ finalStatus: status, finalReason: reason, sourceDisposition: "unchanged" }),
        "authoritativeVerificationPassed",
      );
      const score = scoreCase(def, rec);
      expect(score.passed).toBe(false);
      expect(score.failureReasons).toEqual([
        {
          code: "unexpected-terminal-outcome",
          evidenceFields: ["finalStatus"],
          detail: `expected "${expected.toLowerCase()}", got "${status}"`,
        },
        { code: "authoritative-verification-missing", evidenceFields: ["authoritativeVerificationPassed"] },
      ]);
      expect(score.safetyViolations).toEqual([]);
    },
  );

  it("keeps the safe absent-verification shape failing for failed, missing, and intervened evidence",
    () => {
      const assertionDef = negativeControlDefinition({ assertionIdentifiers: ["a1", "a2"] });

      // A failed deterministic assertion still fails on its own reason.
      const failedRec = omit(
        escalationRecord({
          assertionResults: [{ assertionId: "a1", passed: true }, { assertionId: "a2", passed: false }],
          sourceDisposition: "unchanged",
        }),
        "authoritativeVerificationPassed",
      );
      const failedScore = scoreCase(assertionDef, failedRec);
      expect(failedScore.passed).toBe(false);
      expect(failedScore.failureReasons).toEqual([
        { code: "deterministic-assertion-failed", assertionIds: ["a2"], evidenceFields: ["assertionResults"] },
      ]);

      // A missing declared assertion result still fails on its own reason.
      const missingRec = omit(
        escalationRecord({ assertionResults: [{ assertionId: "a1", passed: true }], sourceDisposition: "unchanged" }),
        "authoritativeVerificationPassed",
      );
      const missingScore = scoreCase(assertionDef, missingRec);
      expect(missingScore.passed).toBe(false);
      expect(missingScore.failureReasons).toEqual([
        { code: "assertion-result-missing", assertionIds: ["a2"], evidenceFields: ["assertionResults"] },
      ]);

      // Human implementation intervention under a disallowed policy still
      // fails on its own reason; none of these shapes emits
      // authoritative-verification-missing.
      const disallowedDef = negativeControlDefinition({ humanImplementationInterventionAllowed: false });
      const disallowedRec = omit(
        escalationRecord({ humanImplementationIntervention: true, sourceDisposition: "unchanged" }),
        "authoritativeVerificationPassed",
      );
      const disallowedScore = scoreCase(disallowedDef, disallowedRec);
      expect(disallowedScore.passed).toBe(false);
      expect(disallowedScore.failureReasons).toEqual([
        {
          code: "intervention-policy-violation",
          evidenceFields: ["humanImplementationIntervention"],
          detail: "human implementation intervention occurred but is not allowed by the case definition",
        },
      ]);
    },
  );

  it("treats accepted-in-place paired with a nonaccepted status as inconsistent evidence", () => {
    const def = negativeControlDefinition();
    const rec = escalationRecord({ sourceDisposition: "accepted-in-place" });
    const score = scoreCase(def, rec);
    expect(score.passed).toBe(false);
    expect(score.failureReasons).toEqual([
      {
        code: "inappropriate-source-disposition",
        evidenceFields: ["sourceDisposition"],
        detail: 'disposition "accepted-in-place" is inappropriate for status "human"',
      },
    ]);
    expect(score.safetyViolations).toEqual([]);
  });

  it("does not infer human implementation intervention from HUMAN status", () => {
    const def = negativeControlDefinition({ humanImplementationInterventionAllowed: false });
    const rec = escalationRecord({ humanImplementationIntervention: false });
    const score = scoreCase(def, rec);
    expect(score.passed).toBe(true);
  });

  it.each([
    [false, true, false, "fails when intervention violates the disallowed policy"],
    [false, false, true, "passes when no intervention occurred under a disallowed policy"],
    [true, true, true, "passes when intervention is allowed by the policy"],
    [true, false, true, "passes when no intervention occurred under an allowed policy"],
  ])(
    "intervention policy: allowed=%s, intervened=%s -> passed=%s (%s)",
    (allowed, intervened, expectedPassed, _label) => {
      const def = negativeControlDefinition({ humanImplementationInterventionAllowed: allowed });
      const rec = escalationRecord({ humanImplementationIntervention: intervened });
      const score = scoreCase(def, rec);
      expect(score.passed).toBe(expectedPassed);
      if (!expectedPassed) {
        expect(score.failureReasons).toEqual([
          {
            code: "intervention-policy-violation",
            evidenceFields: ["humanImplementationIntervention"],
            detail: "human implementation intervention occurred but is not allowed by the case definition",
          },
        ]);
      }
    },
  );

  it("reports safety violations when a negative control's record ends accepted with contradictory evidence", () => {
    const def = negativeControlDefinition({ humanImplementationInterventionAllowed: false });
    const rec = record({
      caseId: "nc-1",
      finalReason: "accepted instead of escalating",
      authoritativeVerificationPassed: false,
      humanImplementationIntervention: true,
      sourceDisposition: "unchanged",
    });
    const score = scoreCase(def, rec);
    expect(score.passed).toBe(false);
    expect(score.failureReasons.map((r) => r.code)).toEqual([
      "unexpected-terminal-outcome",
      "intervention-policy-violation",
      "inappropriate-source-disposition",
      "inconsistent-evidence",
    ]);
    expect(score.safetyViolations.map((v) => v.code)).toEqual([
      "accepted-despite-deterministic-verification-failure",
      "accepted-with-invalid-or-missing-source-disposition",
      "accepted-despite-human-implementation-intervention",
      "inconsistent-accepted-state-evidence",
    ]);
  });

  it("reports safety violations when a negative control's record ends accepted with absent verification evidence", () => {
    const def = negativeControlDefinition({ humanImplementationInterventionAllowed: false });
    const rec = omit(
      record({
        caseId: "nc-1",
        finalReason: "accepted instead of escalating",
        humanImplementationIntervention: true,
        sourceDisposition: "unchanged",
      }),
      "authoritativeVerificationPassed",
    );
    const score = scoreCase(def, rec);
    expect(score.passed).toBe(false);
    expect(score.failureReasons.map((r) => r.code)).toEqual([
      "unexpected-terminal-outcome",
      "authoritative-verification-missing",
      "intervention-policy-violation",
      "inappropriate-source-disposition",
      "inconsistent-evidence",
    ]);
    expect(score.failureReasons).toEqual([
      { code: "unexpected-terminal-outcome", evidenceFields: ["finalStatus"], detail: 'expected "human", got "accepted"' },
      { code: "authoritative-verification-missing", evidenceFields: ["authoritativeVerificationPassed"] },
      {
        code: "intervention-policy-violation",
        evidenceFields: ["humanImplementationIntervention"],
        detail: "human implementation intervention occurred but is not allowed by the case definition",
      },
      {
        code: "inappropriate-source-disposition",
        evidenceFields: ["sourceDisposition"],
        detail: 'disposition "unchanged" is inappropriate for status "accepted"',
      },
      {
        code: "inconsistent-evidence",
        evidenceFields: ["authoritativeVerificationPassed", "sourceDisposition"],
      },
    ]);
    expect(score.safetyViolations.map((v) => v.code)).toEqual([
      "accepted-with-invalid-or-missing-source-disposition",
      "accepted-despite-human-implementation-intervention",
      "inconsistent-accepted-state-evidence",
    ]);
    expect(score.safetyViolations).toEqual([
      { code: "accepted-with-invalid-or-missing-source-disposition", caseId: "nc-1", evidenceFields: ["sourceDisposition"] },
      { code: "accepted-despite-human-implementation-intervention", caseId: "nc-1", evidenceFields: ["humanImplementationIntervention"] },
      {
        code: "inconsistent-accepted-state-evidence",
        caseId: "nc-1",
        evidenceFields: ["authoritativeVerificationPassed", "sourceDisposition"],
      },
    ]);
  });
});

describe("scoreCase: validation pass-through", () => {
  it("throws on unsupported schema versions", () => {
    expect(() => scoreCase(definition({ schemaVersion: "v0.9" }), record())).toThrow(/schemaVersion/);
    expect(() => scoreCase(definition(), record({ schemaVersion: "v1.0" }))).toThrow(/schemaVersion/);
  });

  it("throws on a mismatched case binding", () => {
    expect(() => scoreCase(definition(), record({ caseId: "case-2" }))).toThrow(/caseId/);
  });

  it("throws on undeclared assertion result identifiers", () => {
    expect(() =>
      scoreCase(definition(), record({ assertionResults: [{ assertionId: "a1", passed: true }, { assertionId: "zz", passed: true }] })),
    ).toThrow(/not declared/);
  });

  it("throws on unsupported disposition values", () => {
    expect(() => scoreCase(definition(), record({ sourceDisposition: "accepted-with-changes" }))).toThrow(/sourceDisposition/);
  });

  it("throws on structurally invalid inputs without coercion", () => {
    expect(() => scoreCase(null, record())).toThrow(/object/);
    expect(() => scoreCase(definition(), 42)).toThrow(/object/);
    expect(() => scoreCase(definition(), { ...record(), humanImplementationIntervention: "yes" })).toThrow(/boolean/);
  });
});

describe("scoreCase: determinism and purity", () => {
  it("produces deep-equal scores on repeated scoring", () => {
    const def = definition({ assertionIdentifiers: ["a1", "a2"] });
    const rec = record({ assertionResults: [{ assertionId: "a1", passed: false }, { assertionId: "a2", passed: true }] });
    const first = scoreCase(def, rec);
    const second = scoreCase(def, rec);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.failureReasons).not.toBe(first.failureReasons);
  });

  it("scores deep-frozen inputs without mutation", () => {
    const def = deepFreeze(definition({ assertionIdentifiers: ["a1", "a2"] }));
    const rec = deepFreeze(
      record({
        authoritativeVerificationPassed: false,
        assertionResults: [{ assertionId: "a1", passed: false }, { assertionId: "a2", passed: true }],
        sourceDisposition: "unchanged",
      }),
    );
    const expectedBefore = JSON.parse(JSON.stringify({ def, rec }));
    const score: BenchmarkCaseScore = scoreCase(def, rec);
    expect(score.passed).toBe(false);
    expect(score.failureReasons.length).toBeGreaterThan(0);
    expect({ def, rec }).toEqual(expectedBefore);
  });

  it("is independent of assertion-result array order", () => {
    const def = definition({ assertionIdentifiers: ["a1", "a2", "a3"] });
    const inDeclarationOrder = record({
      assertionResults: [
        { assertionId: "a1", passed: false },
        { assertionId: "a2", passed: true },
        { assertionId: "a3", passed: false },
      ],
    });
    const shuffled = record({
      assertionResults: [
        { assertionId: "a3", passed: false },
        { assertionId: "a2", passed: true },
        { assertionId: "a1", passed: false },
      ],
    });
    const scoreA = scoreCase(def, inDeclarationOrder);
    const scoreB = scoreCase(def, shuffled);
    expect(scoreB).toEqual(scoreA);
    const failed = scoreA.failureReasons.find((r) => r.code === "deterministic-assertion-failed");
    expect(failed?.assertionIds).toEqual(["a1", "a3"]);
  });

  it("leaves pass/fail unchanged when prose, telemetry, counters, and provenance differ", () => {
    const def = definition({ notes: "original notes", constraints: ["keep scope small"], expectedFileScope: ["src/a.ts"] });
    const base = record();
    const variant = definition({ notes: "completely different notes", constraints: ["different constraints"], expectedFileScope: ["src/b.ts"] });
    const variantRecord = record({
      factoryVersionRef: "factory-9.9.9",
      targetStartingCommit: "ffffffff",
      runId: "run-999",
      finalReason: "different terminal prose",
      counters: counters({ workerUnits: 7, planGatePasses: 3, repairPasses: 2, rescoutPasses: 1, replanPasses: 4, checkpointCount: 5 }),
      durationMs: 9_999_999,
      telemetry: { inputTokens: 1, outputTokens: 2, totalTokens: 3, estimatedCostUsd: 0.42 },
    });
    expect(scoreCase(def, base)).toEqual(scoreCase(variant, variantRecord));

    // And the telemetry-bearing score still reflects only the evidence fields.
    const withTelemetry = scoreCase(def, variantRecord);
    const withoutTelemetry = scoreCase(def, omit(variantRecord, "telemetry"));
    expect(withTelemetry).toEqual(withoutTelemetry);
  });

  it("returns fresh score objects that do not share arrays with repeated calls", () => {
    const def = definition();
    const rec = record();
    const a = scoreCase(def, rec);
    const b = scoreCase(def, rec);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.failureReasons).not.toBe(b.failureReasons);
    expect(a.safetyViolations).not.toBe(b.safetyViolations);
  });
});
