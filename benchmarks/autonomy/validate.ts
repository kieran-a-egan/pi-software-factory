/**
 * Fail-closed runtime validation for the isolated v1 autonomy-benchmark
 * contracts declared in {@link ./types.js}.
 *
 * Every entry point accepts `unknown` and throws a descriptive `Error` on the
 * first structural violation. Validation never coerces: no trimming, no
 * case-folding, no JSON parsing, no defaulting of booleans, no filtering of
 * invalid entries. Wrong-typed or unknown enum values, unsupported schema
 * versions, duplicate or undeclared assertion identifiers, and malformed
 * telemetry are errors, not scores.
 *
 * Sparse arrays (holes) in the validated array fields are also errors: every
 * index from zero through length minus one must hold an own indexed entry
 * before element validation is applied; inherited values do not count.
 *
 * Supported object containers are exactly non-null objects whose prototype is
 * `Object.prototype` or `null` (null-prototype dictionaries are intentionally
 * retained). `Date`, `Map`, `Set`, `RegExp`, and class-instance containers are
 * rejected at the `requireObject` boundary.
 *
 * Documented incomplete-evidence states are *not* errors:
 * - `authoritativeVerificationPassed` may be absent,
 * - `sourceDisposition` may be absent,
 * - `assertionResults` may omit declared assertion identifiers.
 *
 * Validation also deliberately stops at structure: a known disposition that is
 * inappropriate for the terminal status, an explicit `false` verification
 * flag, or a failing assertion is valid record shape — the scorer reports
 * those as violations, not the validator.
 *
 * Pure: inputs are never mutated, and the returned values are fresh objects
 * built only from validated fields.
 */
import type {
  BenchmarkAssertionResult,
  BenchmarkCaseDefinition,
  BenchmarkCaseKind,
  BenchmarkExpectedTerminalOutcome,
  BenchmarkExecutionRecord,
  BenchmarkRunCounters,
  BenchmarkSourceDisposition,
  BenchmarkTelemetry,
  BenchmarkTerminalStatus,
} from "./types.js";
import { BENCHMARK_SCHEMA_VERSION } from "./types.js";

const EXPECTED_OUTCOMES: readonly BenchmarkExpectedTerminalOutcome[] = ["ACCEPTED", "HUMAN", "BLOCKED"];
const TERMINAL_STATUSES: readonly BenchmarkTerminalStatus[] = ["accepted", "human", "failed", "blocked"];
const SOURCE_DISPOSITIONS: readonly BenchmarkSourceDisposition[] = [
  "active-unaccepted",
  "unchanged",
  "accepted-in-place",
  "retained-unaccepted",
  "unknown-retained",
];
const CASE_KINDS: readonly BenchmarkCaseKind[] = ["solvable", "negative-control"];
const TOKEN_TELEMETRY_FIELDS = ["inputTokens", "outputTokens", "totalTokens"] as const;

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * A supported object container is a non-null object whose prototype is
 * exactly `Object.prototype` or `null`. Arrays, `Date`, `Map`, `Set`,
 * `RegExp`, class instances, and other custom-prototype containers are not
 * supported object shapes. Null-prototype objects are intentionally
 * accepted: they are plain dictionaries and must keep working.
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
  const str = requireString(value, name);
  if (str.length === 0) throw new Error(`${name} must be a nonempty string`);
  return str;
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean, got ${describeType(value)}`);
  return value;
}

function requireEnum<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  const str = requireString(value, name);
  if (!allowed.includes(str as T)) {
    throw new Error(`${name} must be one of ${allowed.map((a) => `"${a}"`).join(", ")}, got ${JSON.stringify(str)}`);
  }
  return str as T;
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

function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  return describeType(value);
}

/**
 * Build a fresh dense array by validating every index from zero through
 * length minus one. A missing own indexed entry is a hole: values inherited
 * from the prototype chain do not fill it, and holes are rejected rather than
 * filtered, compacted, or coerced.
 */
function requireDenseElements<T>(
  value: readonly unknown[],
  name: string,
  validateEntry: (entry: unknown, index: number) => T,
): T[] {
  const length = value.length;
  const result: T[] = new Array(length);
  for (let i = 0; i < length; i++) {
    if (!Object.prototype.hasOwnProperty.call(value, i)) {
      throw new Error(`${name}[${i}] is missing (sparse arrays are not allowed)`);
    }
    result[i] = validateEntry(value[i], i);
  }
  return result;
}

function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of strings, got ${describeType(value)}`);
  return requireDenseElements(value, name, (entry, i) => requireString(entry, `${name}[${i}]`));
}

function requireSchemaVersion(value: unknown): BenchmarkCaseDefinition["schemaVersion"] {
  if (value !== BENCHMARK_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be exactly "${BENCHMARK_SCHEMA_VERSION}", got ${describeValue(value)}`);
  }
  return BENCHMARK_SCHEMA_VERSION;
}

function requireAssertionIdentifiers(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error(`assertionIdentifiers must be an array, got ${describeType(value)}`);
  const identifiers = requireDenseElements(value, "assertionIdentifiers", (entry, i) =>
    requireNonEmptyString(entry, `assertionIdentifiers[${i}]`),
  );
  if (identifiers.length === 0) throw new Error("assertionIdentifiers must declare at least one assertion identifier");
  const seen = new Set<string>();
  for (const identifier of identifiers) {
    if (seen.has(identifier)) {
      throw new Error(`assertionIdentifiers contains duplicate identifier ${JSON.stringify(identifier)}`);
    }
    seen.add(identifier);
  }
  return identifiers;
}

function requireAssertionResults(value: unknown): BenchmarkAssertionResult[] {
  if (!Array.isArray(value)) throw new Error(`assertionResults must be an array, got ${describeType(value)}`);
  const seen = new Set<string>();
  return requireDenseElements(value, "assertionResults", (entry, i) => {
    const item = requireObject(entry, `assertionResults[${i}]`);
    const assertionId = requireNonEmptyString(item.assertionId, `assertionResults[${i}].assertionId`);
    const passed = requireBoolean(item.passed, `assertionResults[${i}].passed`);
    if (seen.has(assertionId)) {
      throw new Error(`assertionResults[${i}]: duplicate result for assertion identifier ${JSON.stringify(assertionId)}`);
    }
    seen.add(assertionId);
    return { assertionId, passed };
  });
}

function requireCounters(value: unknown): BenchmarkRunCounters {
  const v = requireObject(value, "counters");
  return {
    workerUnits: requireNonNegativeSafeInteger(v.workerUnits, "counters.workerUnits"),
    planGatePasses: requireNonNegativeSafeInteger(v.planGatePasses, "counters.planGatePasses"),
    repairPasses: requireNonNegativeSafeInteger(v.repairPasses, "counters.repairPasses"),
    rescoutPasses: requireNonNegativeSafeInteger(v.rescoutPasses, "counters.rescoutPasses"),
    replanPasses: requireNonNegativeSafeInteger(v.replanPasses, "counters.replanPasses"),
    continuationCount: requireNonNegativeSafeInteger(v.continuationCount, "counters.continuationCount"),
    checkpointCount: requireNonNegativeSafeInteger(v.checkpointCount, "counters.checkpointCount"),
    parallelBatchCount: requireNonNegativeSafeInteger(v.parallelBatchCount, "counters.parallelBatchCount"),
  };
}

function requireTelemetry(value: unknown): BenchmarkTelemetry {
  const v = requireObject(value, "telemetry");
  const telemetry: BenchmarkTelemetry = {};
  for (const field of TOKEN_TELEMETRY_FIELDS) {
    if (v[field] !== undefined) telemetry[field] = requireNonNegativeSafeInteger(v[field], `telemetry.${field}`);
  }
  if (v.estimatedCostUsd !== undefined) {
    telemetry.estimatedCostUsd = requireFiniteNonNegativeNumber(v.estimatedCostUsd, "telemetry.estimatedCostUsd");
  }
  return telemetry;
}

/**
 * Validate an unknown value as a benchmark case definition.
 *
 * Enforces: nonempty `id`, exact `schemaVersion` "v1", a known `kind` and
 * `expectedTerminalOutcome` with a valid kind/outcome combination (solvable →
 * ACCEPTED; negative-control → HUMAN or BLOCKED), nonempty string
 * `category`/`objective`, exact booleans, at least one unique nonempty
 * assertion identifier, and string/string-array shapes for the optional
 * metadata fields.
 */
export function validateBenchmarkCaseDefinition(value: unknown): BenchmarkCaseDefinition {
  const v = requireObject(value, "benchmark case definition");

  const id = requireNonEmptyString(v.id, "id");
  const schemaVersion = requireSchemaVersion(v.schemaVersion);
  const kind = requireEnum(v.kind, "kind", CASE_KINDS);
  const category = requireString(v.category, "category");
  const objective = requireString(v.objective, "objective");
  const expectedTerminalOutcome = requireEnum(v.expectedTerminalOutcome, "expectedTerminalOutcome", EXPECTED_OUTCOMES);
  const humanImplementationInterventionAllowed = requireBoolean(
    v.humanImplementationInterventionAllowed,
    "humanImplementationInterventionAllowed",
  );
  const assertionIdentifiers = requireAssertionIdentifiers(v.assertionIdentifiers);

  if (kind === "solvable" && expectedTerminalOutcome !== "ACCEPTED") {
    throw new Error(
      `benchmark case definition ${JSON.stringify(id)}: a solvable case must expect terminal outcome "ACCEPTED", got ${JSON.stringify(expectedTerminalOutcome)}`,
    );
  }
  if (kind === "negative-control" && expectedTerminalOutcome !== "HUMAN" && expectedTerminalOutcome !== "BLOCKED") {
    throw new Error(
      `benchmark case definition ${JSON.stringify(id)}: a negative-control case must expect terminal outcome "HUMAN" or "BLOCKED", got ${JSON.stringify(expectedTerminalOutcome)}`,
    );
  }

  const definition: BenchmarkCaseDefinition = {
    id,
    schemaVersion,
    kind,
    category,
    objective,
    expectedTerminalOutcome,
    humanImplementationInterventionAllowed,
    assertionIdentifiers,
  };
  if (v.expectedFileScope !== undefined) definition.expectedFileScope = requireStringArray(v.expectedFileScope, "expectedFileScope");
  if (v.notes !== undefined) definition.notes = requireString(v.notes, "notes");
  if (v.constraints !== undefined) definition.constraints = requireStringArray(v.constraints, "constraints");
  return definition;
}

/**
 * Validate an unknown value as a benchmark execution record.
 *
 * Enforces: nonempty `caseId` and provenance strings, exact `schemaVersion`
 * "v1", a known lowercase `finalStatus`, nonempty `finalReason`, exact
 * booleans for `authoritativeVerificationPassed` (when present) and
 * `humanImplementationIntervention`, well-formed unique assertion results,
 * a known `sourceDisposition` literal (when present), all required
 * nonnegative safe-integer counters, a finite nonnegative `durationMs`, and
 * well-formed optional telemetry.
 *
 * Deliberately does *not* reject: absent `authoritativeVerificationPassed`,
 * absent `sourceDisposition`, `assertionResults` omitting declared
 * identifiers, a present `false` verification flag, or a known disposition
 * that is inappropriate for the terminal status — those are scoring inputs,
 * not structural violations.
 */
export function validateBenchmarkExecutionRecord(value: unknown): BenchmarkExecutionRecord {
  const v = requireObject(value, "benchmark execution record");

  const caseId = requireNonEmptyString(v.caseId, "caseId");
  const schemaVersion = requireSchemaVersion(v.schemaVersion);
  const factoryVersionRef = requireNonEmptyString(v.factoryVersionRef, "factoryVersionRef");
  const targetStartingCommit = requireNonEmptyString(v.targetStartingCommit, "targetStartingCommit");
  const runId = requireNonEmptyString(v.runId, "runId");
  const finalStatus = requireEnum(v.finalStatus, "finalStatus", TERMINAL_STATUSES);
  const finalReason = requireNonEmptyString(v.finalReason, "finalReason");
  const humanImplementationIntervention = requireBoolean(v.humanImplementationIntervention, "humanImplementationIntervention");
  const assertionResults = requireAssertionResults(v.assertionResults);
  const counters = requireCounters(v.counters);
  const durationMs = requireFiniteNonNegativeNumber(v.durationMs, "durationMs");

  const record: BenchmarkExecutionRecord = {
    caseId,
    schemaVersion,
    factoryVersionRef,
    targetStartingCommit,
    runId,
    finalStatus,
    finalReason,
    humanImplementationIntervention,
    assertionResults,
    counters,
    durationMs,
  };
  if (v.authoritativeVerificationPassed !== undefined) {
    record.authoritativeVerificationPassed = requireBoolean(v.authoritativeVerificationPassed, "authoritativeVerificationPassed");
  }
  if (v.sourceDisposition !== undefined) {
    record.sourceDisposition = requireEnum(v.sourceDisposition, "sourceDisposition", SOURCE_DISPOSITIONS);
  }
  if (v.telemetry !== undefined) {
    record.telemetry = requireTelemetry(v.telemetry);
  }
  return record;
}

/**
 * Validate the binding between an already-structurally-validated definition
 * and record: the record's `schemaVersion` and `caseId` must match the
 * definition's `schemaVersion` and `id` exactly, and every assertion result
 * must correspond to an identifier declared by the definition. Missing
 * declared assertion results are permitted (incomplete evidence).
 */
export function validateBenchmarkCaseBinding(
  definition: BenchmarkCaseDefinition,
  record: BenchmarkExecutionRecord,
): void {
  if (record.schemaVersion !== definition.schemaVersion) {
    throw new Error(
      `case binding: record schemaVersion ${describeValue(record.schemaVersion)} does not match definition schemaVersion ${describeValue(definition.schemaVersion)}`,
    );
  }
  if (record.caseId !== definition.id) {
    throw new Error(
      `case binding: record caseId ${describeValue(record.caseId)} does not match definition id ${describeValue(definition.id)}`,
    );
  }
  const declared = new Set(definition.assertionIdentifiers);
  for (const result of record.assertionResults) {
    if (!declared.has(result.assertionId)) {
      throw new Error(
        `case binding: assertion result ${JSON.stringify(result.assertionId)} is not declared by definition ${JSON.stringify(definition.id)}`,
      );
    }
  }
}

/**
 * Validate an unknown definition and an unknown record, then validate their
 * binding. Returns the fresh, fully validated pair.
 */
export function validateBenchmarkCasePair(definition: unknown, record: unknown): {
  definition: BenchmarkCaseDefinition;
  record: BenchmarkExecutionRecord;
} {
  const validatedDefinition = validateBenchmarkCaseDefinition(definition);
  const validatedRecord = validateBenchmarkExecutionRecord(record);
  validateBenchmarkCaseBinding(validatedDefinition, validatedRecord);
  return { definition: validatedDefinition, record: validatedRecord };
}
