/**
 * Table-driven coverage for the fail-closed v1 autonomy-benchmark validators
 * (benchmarks/autonomy/validate.ts):
 *
 * - structural acceptance of well-formed definitions, records, and pairs,
 * - rejection of unsupported versions, unknown enums (never case-coerced),
 *   wrong-typed or null evidence, invalid kind/outcome combinations,
 *   duplicate or undeclared assertion identifiers, malformed telemetry,
 *   NaN/Infinity/negative/non-integer counters and durations,
 * - the documented incomplete-evidence forms that validation must permit:
 *   omitted verification/disposition and absent declared assertion results,
 * - known-but-inappropriate evidence (false verification flag, wrong-for-
 *   accepted disposition) passing validation so the scorer can report it,
 * - purity: inputs are never mutated and results are fresh objects.
 */
import { describe, expect, it } from "vitest";

import {
  validateBenchmarkCaseBinding,
  validateBenchmarkCaseDefinition,
  validateBenchmarkCasePair,
  validateBenchmarkExecutionRecord,
} from "../benchmarks/autonomy/validate.js";
import type {
  BenchmarkAssertionResult,
  BenchmarkCaseDefinition,
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

function record(overrides: Record<string, unknown> = {}): BenchmarkExecutionRecord {
  return {
    caseId: "case-1",
    schemaVersion: "v1",
    factoryVersionRef: "factory-0.8.1",
    targetStartingCommit: "abc123def",
    runId: "run-1",
    finalStatus: "accepted",
    finalReason: "verification passed",
    assertionResults: [{ assertionId: "a1", passed: true }],
    humanImplementationIntervention: false,
    counters: counters(),
    durationMs: 120,
    ...overrides,
  } as BenchmarkExecutionRecord;
}

/** Copy `obj` without `key` so "missing field" cases drop the key entirely. */
function omit(obj: object, key: string): Record<string, unknown> {
  const copy = { ...(obj as Record<string, unknown>) };
  delete copy[key];
  return copy;
}

describe("validateBenchmarkCaseDefinition", () => {
  it("accepts a well-formed solvable definition and returns a fresh equal object", () => {
    const input = definition();
    const validated = validateBenchmarkCaseDefinition(input);
    expect(validated).toEqual(input);
    expect(validated).not.toBe(input);
    expect(validated.assertionIdentifiers).not.toBe(input.assertionIdentifiers);
    expect(input).toEqual(definition());
  });

  it("accepts all optional metadata fields with valid shapes", () => {
    const input = definition({
      expectedFileScope: ["src/a.ts", "src/b.ts"],
      notes: "optional notes",
      constraints: ["no new dependencies"],
    });
    expect(validateBenchmarkCaseDefinition(input)).toEqual(input);
  });

  it("accepts a negative-control definition expecting HUMAN", () => {
    const input = definition({
      id: "nc-1",
      kind: "negative-control",
      expectedTerminalOutcome: "HUMAN",
      humanImplementationInterventionAllowed: true,
    });
    expect(validateBenchmarkCaseDefinition(input)).toEqual(input);
  });

  it("accepts a negative-control definition expecting BLOCKED", () => {
    const input = definition({ id: "nc-2", kind: "negative-control", expectedTerminalOutcome: "BLOCKED" });
    expect(validateBenchmarkCaseDefinition(input)).toEqual(input);
  });

  it.each([
    ["null", null],
    ["boolean", true],
    ["number", 42],
    ["string", "case-1"],
    ["array", [definition()]],
    ["empty object", {}],
  ] as Array<[string, unknown]>)(
    "rejects a non-object definition: %s",
    (_name, value) => {
      expect(() => validateBenchmarkCaseDefinition(value)).toThrow();
    },
  );

  it.each([
    ["missing id", omit(definition(), "id")],
    ["empty id", definition({ id: "" })],
    ["non-string id", definition({ id: 7 })],
    ["id of type null", definition({ id: null })],
    ["missing schemaVersion", omit(definition(), "schemaVersion")],
    ["unsupported schemaVersion v0.9", definition({ schemaVersion: "v0.9" })],
    ["unsupported schemaVersion v2", definition({ schemaVersion: "v2" })],
    ["schemaVersion v1 as number", definition({ schemaVersion: 1 })],
    ["schemaVersion as null", definition({ schemaVersion: null })],
    ["missing kind", omit(definition(), "kind")],
    ["uppercase kind", definition({ kind: "SOLVABLE" })],
    ["mixed-case kind", definition({ kind: "Solvable" })],
    ["unknown kind", definition({ kind: "adversarial" })],
    ["kind as null", definition({ kind: null })],
    ["missing category", omit(definition(), "category")],
    ["non-string category", definition({ category: 1 })],
    ["missing objective", omit(definition(), "objective")],
    ["non-string objective", definition({ objective: ["do it"] })],
    ["missing expectedTerminalOutcome", omit(definition(), "expectedTerminalOutcome")],
    ["lowercase outcome (no case coercion)", definition({ expectedTerminalOutcome: "accepted" })],
    ["outcome with surrounding space", definition({ expectedTerminalOutcome: "ACCEPTED " })],
    ["unknown outcome", definition({ expectedTerminalOutcome: "PENDING" })],
    ["missing humanImplementationInterventionAllowed", omit(definition(), "humanImplementationInterventionAllowed")],
    ["string intervention flag", definition({ humanImplementationInterventionAllowed: "false" })],
    ["numeric intervention flag", definition({ humanImplementationInterventionAllowed: 0 })],
    ["null intervention flag", definition({ humanImplementationInterventionAllowed: null })],
    ["missing assertionIdentifiers", omit(definition(), "assertionIdentifiers")],
    ["empty assertionIdentifiers", definition({ assertionIdentifiers: [] })],
    ["non-array assertionIdentifiers", definition({ assertionIdentifiers: "a1" })],
    ["empty assertion identifier", definition({ assertionIdentifiers: [""] })],
    ["non-string assertion identifier", definition({ assertionIdentifiers: ["a1", 2] })],
    ["duplicate assertion identifiers", definition({ assertionIdentifiers: ["a1", "a1"] })],
    ["string expectedFileScope", definition({ expectedFileScope: "src/a.ts" })],
    ["non-string expectedFileScope entry", definition({ expectedFileScope: ["src/a.ts", 3] })],
    ["number notes", definition({ notes: 42 })],
    ["string constraints", definition({ constraints: "none" })],
    ["non-string constraints entry", definition({ constraints: ["none", null] })],
  ] as Array<[string, unknown]>)(
    "rejects a malformed definition: %s",
    (_name, value) => {
      expect(() => validateBenchmarkCaseDefinition(value)).toThrow();
    },
  );

  it.each([
    ["solvable expecting HUMAN", definition({ expectedTerminalOutcome: "HUMAN" })],
    ["solvable expecting BLOCKED", definition({ expectedTerminalOutcome: "BLOCKED" })],
    ["negative-control expecting ACCEPTED", definition({ kind: "negative-control", expectedTerminalOutcome: "ACCEPTED" })],
  ] as Array<[string, unknown]>)(
    "rejects an invalid kind/outcome combination: %s",
    (_name, value) => {
      expect(() => validateBenchmarkCaseDefinition(value)).toThrow();
    },
  );

  it.each([
    ["whitespace-only id is nonempty and not trimmed", definition({ id: " " })],
    ["internal whitespace in id is preserved", definition({ id: "case 1" })],
  ] as Array<[string, unknown]>)(
    "never trims strings (%s)",
    (_name, value) => {
      const input = value as BenchmarkCaseDefinition;
      const validated = validateBenchmarkCaseDefinition(value);
      expect(validated.id).toBe(input.id);
    },
  );
});

describe("validateBenchmarkExecutionRecord", () => {
  it("accepts a well-formed record and returns a fresh equal object", () => {
    const input = record();
    const validated = validateBenchmarkExecutionRecord(input);
    expect(validated).toEqual(input);
    expect(validated).not.toBe(input);
    expect(validated.assertionResults).not.toBe(input.assertionResults);
    expect(validated.counters).not.toBe(input.counters);
    expect(input).toEqual(record());
  });

  it("preserves required continuation and parallel-batch counter values exactly", () => {
    const input = record({ counters: counters({ continuationCount: 3, parallelBatchCount: 4 }) });
    const validated = validateBenchmarkExecutionRecord(input);
    expect(validated.counters.continuationCount).toBe(3);
    expect(validated.counters.parallelBatchCount).toBe(4);
    expect(validated).toEqual(input);
  });

  it.each([
    ["null", null],
    ["number", 1],
    ["array", [record()]],
    ["empty object", {}],
    ["missing caseId", omit(record(), "caseId")],
    ["empty caseId", record({ caseId: "" })],
    ["non-string caseId", record({ caseId: 9 })],
    ["missing factoryVersionRef", omit(record(), "factoryVersionRef")],
    ["empty factoryVersionRef", record({ factoryVersionRef: "" })],
    ["missing targetStartingCommit", omit(record(), "targetStartingCommit")],
    ["empty targetStartingCommit", record({ targetStartingCommit: "" })],
    ["missing runId", omit(record(), "runId")],
    ["empty runId", record({ runId: "" })],
    ["missing schemaVersion", omit(record(), "schemaVersion")],
    ["unsupported schemaVersion v0.9", record({ schemaVersion: "v0.9" })],
    ["uppercase schemaVersion", record({ schemaVersion: "V1" })],
    ["missing finalStatus", omit(record(), "finalStatus")],
    ["capitalized finalStatus", record({ finalStatus: "Accepted" })],
    ["finalStatus with trailing space", record({ finalStatus: "accepted " })],
    ["unknown finalStatus", record({ finalStatus: "done" })],
    ["finalStatus as null", record({ finalStatus: null })],
    ["missing finalReason", omit(record(), "finalReason")],
    ["empty finalReason", record({ finalReason: "" })],
    ["non-string finalReason", record({ finalReason: 0 })],
    ["string authoritativeVerificationPassed", record({ authoritativeVerificationPassed: "true" })],
    ["numeric authoritativeVerificationPassed", record({ authoritativeVerificationPassed: 1 })],
    ["null authoritativeVerificationPassed", record({ authoritativeVerificationPassed: null })],
    ["missing humanImplementationIntervention", omit(record(), "humanImplementationIntervention")],
    ["string humanImplementationIntervention", record({ humanImplementationIntervention: "false" })],
    ["null humanImplementationIntervention", record({ humanImplementationIntervention: null })],
    ["missing assertionResults", omit(record(), "assertionResults")],
    ["non-array assertionResults", record({ assertionResults: "a1" })],
    ["string assertion result", record({ assertionResults: ["a1"] })],
    ["result missing assertionId", record({ assertionResults: [{ passed: true }] })],
    ["result with empty assertionId", record({ assertionResults: [{ assertionId: "", passed: true }] })],
    ["result with non-string assertionId", record({ assertionResults: [{ assertionId: 1, passed: true }] })],
    ["result missing passed", record({ assertionResults: [{ assertionId: "a1" }] })],
    ["string passed", record({ assertionResults: [{ assertionId: "a1", passed: "true" }] })],
    ["numeric passed", record({ assertionResults: [{ assertionId: "a1", passed: 0 }] })],
    ["null passed", record({ assertionResults: [{ assertionId: "a1", passed: null }] })],
    ["duplicate assertion results", record({ assertionResults: [{ assertionId: "a1", passed: true }, { assertionId: "a1", passed: false }] })],
    ["unknown sourceDisposition", record({ sourceDisposition: "unknown" })],
    ["uppercase sourceDisposition", record({ sourceDisposition: "ACCEPTED" })],
    ["sourceDisposition with trailing space", record({ sourceDisposition: "accepted-in-place " })],
    ["numeric sourceDisposition", record({ sourceDisposition: 0 })],
    ["missing counters", omit(record(), "counters")],
    ["string counters", record({ counters: "x" })],
    ["null counters", record({ counters: null })],
    ["counters missing workerUnits", record({ counters: omit(counters(), "workerUnits") })],
    ["counters missing checkpointCount", record({ counters: omit(counters(), "checkpointCount") })],
    ["counters missing continuationCount", record({ counters: omit(counters(), "continuationCount") })],
    ["counters missing parallelBatchCount", record({ counters: omit(counters(), "parallelBatchCount") })],
    ["negative continuationCount", record({ counters: counters({ continuationCount: -1 }) })],
    ["negative parallelBatchCount", record({ counters: counters({ parallelBatchCount: -3 }) })],
    ["NaN continuationCount", record({ counters: counters({ continuationCount: Number.NaN }) })],
    ["Infinity parallelBatchCount", record({ counters: counters({ parallelBatchCount: Number.POSITIVE_INFINITY }) })],
    ["fractional continuationCount", record({ counters: counters({ continuationCount: 1.5 }) })],
    ["fractional parallelBatchCount", record({ counters: counters({ parallelBatchCount: 0.25 }) })],
    ["unsafe-integer continuationCount", record({ counters: counters({ continuationCount: Number.MAX_SAFE_INTEGER + 1 }) })],
    ["unsafe-integer parallelBatchCount", record({ counters: counters({ parallelBatchCount: Number.MAX_SAFE_INTEGER + 1 }) })],
    ["string continuationCount", record({ counters: counters({ continuationCount: "1" }) })],
    ["string parallelBatchCount", record({ counters: counters({ parallelBatchCount: "2" }) })],
    ["null continuationCount", record({ counters: counters({ continuationCount: null }) })],
    ["null parallelBatchCount", record({ counters: counters({ parallelBatchCount: null }) })],
    ["negative counter", record({ counters: counters({ workerUnits: -1 }) })],
    ["NaN counter", record({ counters: counters({ planGatePasses: Number.NaN }) })],
    ["Infinity counter", record({ counters: counters({ repairPasses: Number.POSITIVE_INFINITY }) })],
    ["non-integer counter", record({ counters: counters({ rescoutPasses: 1.5 }) })],
    ["string counter", record({ counters: counters({ replanPasses: "1" }) })],
    ["null counter", record({ counters: counters({ checkpointCount: null }) })],
    ["missing durationMs", omit(record(), "durationMs")],
    ["NaN durationMs", record({ durationMs: Number.NaN })],
    ["Infinity durationMs", record({ durationMs: Number.POSITIVE_INFINITY })],
    ["negative durationMs", record({ durationMs: -5 })],
    ["string durationMs", record({ durationMs: "120" })],
    ["string telemetry", record({ telemetry: "none" })],
    ["number telemetry", record({ telemetry: 5 })],
    ["array telemetry", record({ telemetry: [1] })],
    ["negative token count", record({ telemetry: { inputTokens: -1 } })],
    ["NaN token count", record({ telemetry: { outputTokens: Number.NaN } })],
    ["Infinity token count", record({ telemetry: { totalTokens: Number.POSITIVE_INFINITY } })],
    ["string token count", record({ telemetry: { inputTokens: "10" } })],
    ["negative cost", record({ telemetry: { estimatedCostUsd: -0.01 } })],
    ["NaN cost", record({ telemetry: { estimatedCostUsd: Number.NaN } })],
    ["Infinity cost", record({ telemetry: { estimatedCostUsd: Number.POSITIVE_INFINITY } })],
    ["string cost", record({ telemetry: { estimatedCostUsd: "0.01" } })],
  ] as Array<[string, unknown]>)(
    "rejects a malformed record: %s",
    (_name, value) => {
      expect(() => validateBenchmarkExecutionRecord(value)).toThrow();
    },
  );

  it.each([
    ["absent authoritativeVerificationPassed", record({ authoritativeVerificationPassed: undefined })],
    ["absent sourceDisposition", record({ sourceDisposition: undefined })],
    ["absent telemetry", record({ telemetry: undefined })],
    ["empty telemetry object", record({ telemetry: {} })],
    ["zero telemetry", record({ telemetry: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 } })],
  ] as Array<[string, unknown]>)(
    "permits documented optional/incomplete forms: %s",
    (_name, value) => {
      expect(() => validateBenchmarkExecutionRecord(value)).not.toThrow();
    },
  );

  it.each(["active-unaccepted", "unchanged", "accepted-in-place", "retained-unaccepted", "unknown-retained"])(
    "permits the known source disposition %s",
    (disposition) => {
      expect(() => validateBenchmarkExecutionRecord(record({ sourceDisposition: disposition }))).not.toThrow();
    },
  );

  it.each([
    [
      "absent verification and disposition with empty assertionResults",
      () => {
        const r = omit(omit(record(), "authoritativeVerificationPassed"), "sourceDisposition");
        return record({ ...(r as Record<string, unknown>), assertionResults: [] });
      },
    ],
    [
      "false authoritative verification on a human escalation",
      () => record({ finalStatus: "human", finalReason: "escalated to human", authoritativeVerificationPassed: false }),
    ],
    ["accepted status with an inappropriate known disposition", () =>
      record({ finalStatus: "accepted", sourceDisposition: "unchanged" }),
    ],
    ["accepted status with false authoritative verification", () =>
      record({ finalStatus: "accepted", authoritativeVerificationPassed: false }),
    ],
    [
      "failed deterministic assertion",
      () => record({ assertionResults: [{ assertionId: "a1", passed: false }] }),
    ],
    [
      "true human implementation intervention",
      () => record({ humanImplementationIntervention: true }),
    ],
  ] as Array<[string, () => BenchmarkExecutionRecord]>)(
    "does not reject known-but-inappropriate or incomplete evidence: %s",
    (_name, build) => {
      expect(() => validateBenchmarkExecutionRecord(build())).not.toThrow();
    },
  );
});

describe("validateBenchmarkCaseBinding", () => {
  it("accepts a matching definition and record", () => {
    expect(() => validateBenchmarkCaseBinding(definition(), record())).not.toThrow();
  });

  it("accepts a record that omits declared assertion results (incomplete evidence)", () => {
    const def = definition({ assertionIdentifiers: ["a1", "a2"] });
    const rec = record({ assertionResults: [{ assertionId: "a1", passed: true }] });
    expect(() => validateBenchmarkCaseBinding(def, rec)).not.toThrow();
  });

  it("rejects a mismatched caseId", () => {
    expect(() => validateBenchmarkCaseBinding(definition(), record({ caseId: "case-2" }))).toThrow(/caseId/);
  });

  it("rejects a mismatched schemaVersion", () => {
    const def = { ...definition(), schemaVersion: "v0" } as unknown as BenchmarkCaseDefinition;
    expect(() => validateBenchmarkCaseBinding(def, record())).toThrow(/schemaVersion/);
  });

  it("rejects an undeclared assertion result", () => {
    const def = definition({ assertionIdentifiers: ["a1", "a2"] });
    const rec = record({ assertionResults: [{ assertionId: "a3", passed: true }] });
    expect(() => validateBenchmarkCaseBinding(def, rec)).toThrow(/not declared/);
  });
});

describe("validateBenchmarkCasePair", () => {
  it("validates and binds a well-formed pair", () => {
    const def = definition({ assertionIdentifiers: ["a1", "a2"] });
    const rec = record({ assertionResults: [{ assertionId: "a1", passed: true }, { assertionId: "a2", passed: true }] });
    const { definition: validatedDef, record: validatedRec } = validateBenchmarkCasePair(def, rec);
    expect(validatedDef).toEqual(def);
    expect(validatedRec).toEqual(rec);
  });

  it.each([
    ["definition rejects", () => validateBenchmarkCasePair(definition({ assertionIdentifiers: [] }), record())],
    ["record rejects", () => validateBenchmarkCasePair(definition(), record({ finalStatus: "Accepted" }))],
    ["caseId binding rejects", () => validateBenchmarkCasePair(definition(), record({ caseId: "other" }))],
    [
      "undeclared assertion result rejects",
      () => validateBenchmarkCasePair(definition(), record({ assertionResults: [{ assertionId: "zz", passed: true }] })),
    ],
  ] as Array<[string, () => unknown]>)(
    "throws for: %s",
    (_name, build) => {
      expect(build).toThrow();
    },
  );
});

describe("sparse (hole) arrays", () => {
  /** A string array of `length` with holes at the given indices. */
  function sparseStringArray(length: number, holes: readonly number[], fill = "value"): string[] {
    const arr: string[] = new Array(length);
    for (let i = 0; i < length; i++) {
      if (!holes.includes(i)) arr[i] = fill;
    }
    return arr;
  }

  /** An assertion-result array of `length` with holes at the given indices. */
  function sparseResultArray(length: number, holes: readonly number[]): BenchmarkAssertionResult[] {
    const arr: BenchmarkAssertionResult[] = new Array(length);
    for (let i = 0; i < length; i++) {
      if (!holes.includes(i)) arr[i] = { assertionId: `a${i}`, passed: true };
    }
    return arr;
  }

  const HOLE_SHAPES: Array<[string, number, number[]]> = [
    ["all-hole", 2, [0, 1]],
    ["leading-hole", 3, [0]],
    ["interior-hole", 3, [1]],
    ["trailing-hole", 3, [2]],
  ];

  for (const [shape, length, holes] of HOLE_SHAPES) {
    it(`rejects a ${shape} assertionIdentifiers array with a field/index error`, () => {
      expect(() =>
        validateBenchmarkCaseDefinition(definition({ assertionIdentifiers: sparseStringArray(length, holes) })),
      ).toThrow(/assertionIdentifiers\[\d+\] is missing/);
    });

    it(`rejects a ${shape} assertionResults array with a field/index error`, () => {
      expect(() =>
        validateBenchmarkExecutionRecord(record({ assertionResults: sparseResultArray(length, holes) })),
      ).toThrow(/assertionResults\[\d+\] is missing/);
    });

    it(`rejects a ${shape} expectedFileScope array with a field/index error`, () => {
      expect(() =>
        validateBenchmarkCaseDefinition(
          definition({ expectedFileScope: sparseStringArray(length, holes, "src/a.ts") }),
        ),
      ).toThrow(/expectedFileScope\[\d+\] is missing/);
    });

    it(`rejects a ${shape} constraints array with a field/index error`, () => {
      expect(() =>
        validateBenchmarkCaseDefinition(definition({ constraints: sparseStringArray(length, holes, "no new deps") })),
      ).toThrow(/constraints\[\d+\] is missing/);
    });
  }

  it("rejects an array whose missing own index carries only an inherited value", () => {
    // Local Array subclass so the global Array.prototype is never touched.
    class InheritedIndexArray extends Array {}
    Object.defineProperty(InheritedIndexArray.prototype, "1", { value: "inherited", configurable: true });
    const arr = new InheritedIndexArray(3);
    arr[0] = "a0";
    arr[2] = "a2";
    expect(arr[1]).toBe("inherited");
    expect(Object.prototype.hasOwnProperty.call(arr, "1")).toBe(false);
    expect(() => validateBenchmarkCaseDefinition(definition({ assertionIdentifiers: arr as string[] }))).toThrow(
      /assertionIdentifiers\[1\] is missing/,
    );
  });

  it("retains values and order for dense multi-entry arrays and returns fresh arrays", () => {
    const input = definition({
      expectedFileScope: ["src/a.ts", "src/b.ts", "src/c.ts"],
      constraints: ["c1", "c2"],
      assertionIdentifiers: ["a1", "a2", "a3"],
    });
    const validated = validateBenchmarkCaseDefinition(input);
    expect(validated.assertionIdentifiers).toEqual(["a1", "a2", "a3"]);
    expect(validated.assertionIdentifiers).not.toBe(input.assertionIdentifiers);
    expect(validated.expectedFileScope).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(validated.expectedFileScope).not.toBe(input.expectedFileScope);
    expect(validated.constraints).toEqual(["c1", "c2"]);
    expect(validated.constraints).not.toBe(input.constraints);
  });

  it.each([
    ["empty expectedFileScope", () => expect(validateBenchmarkCaseDefinition(definition({ expectedFileScope: [] }))).toBeDefined()],
    ["empty constraints", () => expect(validateBenchmarkCaseDefinition(definition({ constraints: [] }))).toBeDefined()],
    ["empty assertionResults", () => expect(validateBenchmarkExecutionRecord(record({ assertionResults: [] }))).toBeDefined()],
  ] as Array<[string, () => void]>)("permits %s", (_name, build) => {
    build();
  });

  it("still rejects an empty assertionIdentifiers array", () => {
    expect(() => validateBenchmarkCaseDefinition(definition({ assertionIdentifiers: [] }))).toThrow();
  });
});

describe("object container boundaries", () => {
  /** Class instances are not supported object containers. */
  class TelemetryBox {
    inputTokens = 1;
    totalTokens = 2;
  }

  /** Null-prototype dictionary equivalent of `obj` (retained for compatibility). */
  function nullProto(obj: object): Record<string, unknown> {
    return Object.assign(Object.create(null), obj);
  }

  const EXOTIC_CONTAINERS: Array<[string, object]> = [
    ["Date", new Date(0)],
    ["Map", new Map<string, unknown>()],
    ["Set", new Set<unknown>()],
    ["RegExp", /x/],
    ["class instance", new TelemetryBox()],
  ];

  it.each(EXOTIC_CONTAINERS)(
    "rejects an exotic telemetry container: %s",
    (_name, container) => {
      expect(() => validateBenchmarkExecutionRecord(record({ telemetry: container }))).toThrow(
        /telemetry must be an object/,
      );
    },
  );

  it("rejects an exotic telemetry container carrying otherwise valid telemetry fields, due to shape not fields", () => {
    const carrier = new Date(0);
    (carrier as unknown as Record<string, unknown>).inputTokens = 1;
    (carrier as unknown as Record<string, unknown>).totalTokens = 2;
    const box = new TelemetryBox();
    expect(() => validateBenchmarkExecutionRecord(record({ telemetry: carrier }))).toThrow(
      /telemetry must be an object/,
    );
    expect(() => validateBenchmarkExecutionRecord(record({ telemetry: box }))).toThrow(
      /telemetry must be an object/,
    );
    // Rejection names the container boundary, not a missing/malformed field.
    expect(() => validateBenchmarkExecutionRecord(record({ telemetry: carrier }))).not.toThrow(
      /inputTokens|totalTokens/,
    );
  });

  it.each([
    ["empty telemetry object", () => record({ telemetry: {} })],
    [
      "populated telemetry object",
      () => record({ telemetry: { inputTokens: 7, outputTokens: 3, totalTokens: 10, estimatedCostUsd: 0.25 } }),
    ],
    [
      "null-prototype telemetry dictionary",
      () =>
        record({
          telemetry: nullProto({ inputTokens: 7, outputTokens: 3, totalTokens: 10, estimatedCostUsd: 0.25 }),
        }),
    ],
  ] as Array<[string, () => BenchmarkExecutionRecord]>)(
    "accepts a supported telemetry container: %s",
    (_name, build) => {
      expect(() => validateBenchmarkExecutionRecord(build())).not.toThrow();
    },
  );

  it("preserves recognized field values from a populated telemetry object", () => {
    const validated = validateBenchmarkExecutionRecord(
      record({ telemetry: { inputTokens: 11, totalTokens: 22, estimatedCostUsd: 0.5 } }),
    );
    expect(validated.telemetry).toEqual({ inputTokens: 11, totalTokens: 22, estimatedCostUsd: 0.5 });
  });

  it("preserves recognized field values from a null-prototype telemetry dictionary", () => {
    const validated = validateBenchmarkExecutionRecord(record({ telemetry: nullProto({ totalTokens: 4 }) }));
    expect(validated.telemetry).toEqual({ totalTokens: 4 });
  });

  it.each([
    ["Date-derived definition", () => Object.assign(Object.create(new Date(0)), definition())],
    ["Map-derived definition", () => Object.assign(Object.create(new Map()), definition())],
  ] as Array<[string, () => Record<string, unknown>]>)(
    "rejects an exotic definition container: %s",
    (_name, build) => {
      const input = build();
      // The container is otherwise complete and valid; only the shape differs.
      expect(() => validateBenchmarkCaseDefinition(input)).toThrow(/benchmark case definition must be an object/);
      expect(() => validateBenchmarkCaseDefinition(input)).not.toThrow(/id|schemaVersion|kind/);
    },
  );

  it("rejects a class-instance execution record container", () => {
    class RecordBox {}
    const box: unknown = Object.assign(new RecordBox(), record());
    expect(() => validateBenchmarkExecutionRecord(box)).toThrow(/benchmark execution record must be an object/);
  });

  it("accepts a null-prototype execution record container", () => {
    const validated = validateBenchmarkExecutionRecord(nullProto(record()));
    expect(validated).toEqual(record());
  });

  it("accepts a null-prototype definition container and preserves validated values", () => {
    const validated = validateBenchmarkCaseDefinition(nullProto(definition()));
    expect(validated).toEqual(definition());
  });

  it("accepts a null-prototype counters container and preserves counter values", () => {
    const validated = validateBenchmarkExecutionRecord(record({ counters: nullProto(counters()) }));
    expect(validated.counters).toEqual(counters());
  });

  it("accepts null-prototype assertion-result containers and preserves result values", () => {
    const results: Record<string, unknown>[] = [nullProto({ assertionId: "a1", passed: true })];
    const validated = validateBenchmarkExecutionRecord(record({ assertionResults: results }));
    expect(validated.assertionResults).toEqual([{ assertionId: "a1", passed: true }]);
  });

  it("rejects a Map-derived counters container", () => {
    const exoticCounters = Object.assign(Object.create(new Map()), counters());
    expect(() => validateBenchmarkExecutionRecord(record({ counters: exoticCounters }))).toThrow(
      /counters must be an object/,
    );
  });

  it("rejects a RegExp-derived assertion result container", () => {
    const exoticResult = Object.create(new RegExp("x"), {
      assertionId: { value: "a1" },
      passed: { value: true },
    });
    expect(() => validateBenchmarkExecutionRecord(record({ assertionResults: [exoticResult] }))).toThrow(
      /assertionResults\[0\] must be an object/,
    );
  });

  it.each([
    ["function definition", function () {}],
    ["function record", function () {}],
    ["function telemetry", function () {}],
  ] as Array<[string, unknown]>)("still rejects a function container: %s", (_name, fn) => {
    expect(() => validateBenchmarkCaseDefinition(fn)).toThrow();
    expect(() => validateBenchmarkExecutionRecord(fn)).toThrow();
    expect(() => validateBenchmarkExecutionRecord(record({ telemetry: fn }))).toThrow();
  });

  it.each([
    ["null definition", null],
    ["null record", null],
    ["array definition", [definition()]],
    ["array record", [record()]],
  ] as Array<[string, unknown]>)("still rejects %s", (_name, value) => {
    expect(() => validateBenchmarkCaseDefinition(value)).toThrow();
    expect(() => validateBenchmarkExecutionRecord(value)).toThrow();
  });
});

describe("purity", () => {
  it("does not mutate the supplied definition", () => {
    const input = definition({ expectedFileScope: ["a"], notes: "n", constraints: ["c"] });
    const snapshot = structuredClone(input);
    expect(() => validateBenchmarkCaseDefinition(input)).not.toThrow();
    expect(input).toEqual(snapshot);
  });

  it("does not mutate the supplied record, including omitted evidence fields", () => {
    const input = omit(omit(record(), "authoritativeVerificationPassed"), "sourceDisposition") as unknown as BenchmarkExecutionRecord;
    const snapshot = structuredClone(input);
    expect(() => validateBenchmarkExecutionRecord(input)).not.toThrow();
    expect(input).toEqual(snapshot);
    expect("authoritativeVerificationPassed" in input).toBe(false);
    expect("sourceDisposition" in input).toBe(false);
  });

  it("does not mutate a pair during pair validation", () => {
    const def = definition();
    const rec = record();
    const defSnapshot = structuredClone(def);
    const recSnapshot = structuredClone(rec);
    expect(() => validateBenchmarkCasePair(def, rec)).not.toThrow();
    expect(def).toEqual(defSnapshot);
    expect(rec).toEqual(recSnapshot);
  });
});
