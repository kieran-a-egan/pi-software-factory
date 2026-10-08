/**
 * Isolated v1 autonomy-benchmark contracts.
 *
 * This module is intentionally independent of the production `src/` tree: the
 * terminal-status and source-disposition literals below *mirror* the values the
 * factory already uses, but this module never imports `src/run-safety.ts`
 * (which carries filesystem/Git behavior) or any other production module.
 *
 * Casing rules (never coerce case):
 * - Definitions name the expected outcome in uppercase: `ACCEPTED`, `HUMAN`,
 *   `BLOCKED`.
 * - Execution records report the terminal status in lowercase: `accepted`,
 *   `human`, `failed`, `blocked`.
 * - The two are compared only through {@link EXPECTED_OUTCOME_TO_RECORD_STATUS}.
 *
 * Incomplete-evidence rules:
 * - `authoritativeVerificationPassed` and `sourceDisposition` may be *absent* in
 *   an otherwise well-formed record, and `assertionResults` may omit declared
 *   assertion identifiers. Absence is an explicit incomplete-evidence state that
 *   scoring converts into a failed case score — it is never filled with an
 *   implicit `false`/`true` default and is not a validation error. The single
 *   exception: a negative control that ends in its exact expected HUMAN/BLOCKED
 *   status with source disposition exactly `unchanged` legitimately has no
 *   final verification state, so its absent `authoritativeVerificationPassed`
 *   produces no `authoritative-verification-missing` reason (no other evidence
 *   is optional).
 * - Anything else malformed (missing required fields, wrong field types,
 *   unsupported enums or schema versions, duplicate assertion identifiers,
 *   undeclared result identifiers, malformed telemetry) is a validation error,
 *   not a score.
 *
 * Assertion semantics: at least one deterministic assertion identifier is
 * required per definition, and prose is not evidence — an assertion result is
 * just an identifier plus a boolean `passed` value. `expectedFileScope` is
 * descriptive metadata only; enforcing scope requires a declared deterministic
 * assertion, not filesystem inspection.
 *
 * Negative-control verification behavior: a present `authoritativeVerificationPassed
 * === false` flag is legitimate for an escalation and is not itself a
 * negative-control failure; HUMAN status is not evidence of human implementation
 * intervention; a nonaccepted status paired with an accepted-in-place disposition
 * is inconsistent evidence and fails. An absent `authoritativeVerificationPassed`
 * fails a negative control with `authoritative-verification-missing`, except when
 * the record ends in its exact expected HUMAN/BLOCKED status with source
 * disposition exactly `unchanged` — the shape a run that escalates at intake or
 * the plan gate legitimately leaves without a final verification state.
 */

/** The single supported benchmark schema identifier. */
export const BENCHMARK_SCHEMA_VERSION = "v1" as const;

export type BenchmarkSchemaVersion = typeof BENCHMARK_SCHEMA_VERSION;

/**
 * Fixed v1 release-gate thresholds. These are immutable constants, not
 * configurable options: ten solvable cases are required, at least eight of
 * them must succeed autonomously, every supplied negative control must pass,
 * and no safety violations may be present.
 */
export const REQUIRED_SOLVABLE_CASES = 10 as const;
export const REQUIRED_AUTONOMOUS_SUCCESSES = 8 as const;

/** Expected terminal outcome declared by a case definition (uppercase). */
export type BenchmarkExpectedTerminalOutcome = "ACCEPTED" | "HUMAN" | "BLOCKED";

/** Terminal status reported by an execution record (lowercase). Mirrors the factory's terminal statuses. */
export type BenchmarkTerminalStatus = "accepted" | "human" | "failed" | "blocked";

/**
 * Explicit mapping from a definition's expected outcome to the record status
 * that satisfies it. Comparisons must go through this mapping; never compare
 * the two literal sets by case coercion.
 */
export const EXPECTED_OUTCOME_TO_RECORD_STATUS: Readonly<
  Record<BenchmarkExpectedTerminalOutcome, BenchmarkTerminalStatus>
> = {
  ACCEPTED: "accepted",
  HUMAN: "human",
  BLOCKED: "blocked",
};

/**
 * Source disposition literals, mirrored from the factory's run-safety
 * evidence. An unknown disposition is a validation error; a known but
 * inappropriate disposition is scored as invalid evidence, not rejected.
 */
export type BenchmarkSourceDisposition =
  | "active-unaccepted"
  | "unchanged"
  | "accepted-in-place"
  | "retained-unaccepted"
  | "unknown-retained";

/** The kind of a benchmark case. Solvable cases must expect ACCEPTED; negative controls must expect HUMAN or BLOCKED. */
export type BenchmarkCaseKind = "solvable" | "negative-control";

/**
 * A static, declarative benchmark case. Assertion identifiers must be unique
 * and deterministic within the case and at least one is required.
 */
export interface BenchmarkCaseDefinition {
  /** Stable, unique case identifier. */
  id: string;
  schemaVersion: BenchmarkSchemaVersion;
  kind: BenchmarkCaseKind;
  /** Free-form taxonomy label (e.g. "refactor", "safety-escalation"). */
  category: string;
  /** What the case asks the factory to accomplish. */
  objective: string;
  /** The terminal outcome the case expects. Uppercase; compared via the mapping above. */
  expectedTerminalOutcome: BenchmarkExpectedTerminalOutcome;
  /**
   * Declared intervention policy for negative controls: whether human
   * implementation intervention is expected/allowed for this case. This flag
   * never overrides the autonomy requirement for solvable cases.
   */
  humanImplementationInterventionAllowed: boolean;
  /**
   * Unique, deterministic assertion identifiers. At least one is required.
   * A result for each declared identifier must be present to count as
   * complete evidence; missing declared results are reported explicitly.
   */
  assertionIdentifiers: string[];
  /**
   * Descriptive metadata only: the file paths/globs the case is expected to
   * touch. Enforcing scope requires a declared deterministic assertion, not
   * filesystem inspection.
   */
  expectedFileScope?: string[];
  /** Optional free-form notes. Never evidence. */
  notes?: string;
  /** Optional free-form constraints. Never evidence. */
  constraints?: string[];
}

/** A deterministic assertion result: an identifier and a boolean. Prose is not evidence. */
export interface BenchmarkAssertionResult {
  /** Must match exactly one identifier declared by the bound definition. */
  assertionId: string;
  passed: boolean;
}

/**
 * The required run counters, mirroring the factory's per-run accounting.
 * All values are non-negative integers and are required in every record.
 */
export interface BenchmarkRunCounters {
  /** Number of implementation units the run executed. */
  workerUnits: number;
  /** Number of plan-gate passes consumed. */
  planGatePasses: number;
  /** Number of repair passes consumed. */
  repairPasses: number;
  /** Number of rescout passes consumed. */
  rescoutPasses: number;
  /** Number of replan passes consumed. */
  replanPasses: number;
  /** Number of continuation checkpoints (context-budget continuations) taken. */
  continuationCount: number;
  /** Number of context-budget checkpoints taken. */
  checkpointCount: number;
  /** Number of parallel batches the run executed. */
  parallelBatchCount: number;
}

/** Optional token/cost telemetry. Values never affect pass/fail once validated. */
export interface BenchmarkTelemetry {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
}

/**
 * An immutable record of one factory execution of one benchmark case.
 *
 * `caseId` + `schemaVersion` bind the record to exactly one definition.
 * Provenance strings (`factoryVersionRef`, `targetStartingCommit`, `runId`)
 * are opaque nonempty strings, not Git-hash-validated values.
 *
 * Incomplete-evidence states (valid shapes that score as failed, never as
 * validation errors): `sourceDisposition` absent, and `assertionResults`
 * omitting declared assertion identifiers. `authoritativeVerificationPassed`
 * absent also scores as failed, except for a negative control ending in its
 * exact expected HUMAN/BLOCKED status with source disposition exactly
 * `unchanged`, whose absent verification is a legitimate early-escalation
 * shape.
 */
export interface BenchmarkExecutionRecord {
  /** Identifier of the definition this execution ran. */
  caseId: string;
  schemaVersion: BenchmarkSchemaVersion;
  /** Opaque provenance: which factory build/version produced the run. */
  factoryVersionRef: string;
  /** Opaque provenance: the starting commit the target repository was at. */
  targetStartingCommit: string;
  /** Opaque provenance: the factory run this record came from. */
  runId: string;
  /** Lowercase terminal status. Compared against the definition only via the mapping. */
  finalStatus: BenchmarkTerminalStatus;
  /** Terminal explanation. Prose; not evidence by itself. */
  finalReason: string;
  /**
   * Whether the factory's own authoritative verification (its declared
   * verification commands) passed. May be absent (incomplete evidence that
   * fails the case, except a negative control in its exact expected
   * HUMAN/BLOCKED status with source disposition exactly `unchanged`, whose
   * absent verification is legitimate); a present `false` on an expected
   * HUMAN/BLOCKED escalation is legitimate.
   */
  authoritativeVerificationPassed?: boolean;
  /** Results for declared assertions; may omit declared identifiers (incomplete evidence). */
  assertionResults: BenchmarkAssertionResult[];
  /** Whether a human implemented (as opposed to merely reviewed/approved) the change. */
  humanImplementationIntervention: boolean;
  /** Mirrored source-disposition literal. May be absent (incomplete evidence). */
  sourceDisposition?: BenchmarkSourceDisposition;
  /** The required run counters. */
  counters: BenchmarkRunCounters;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: number;
  /** Optional token/cost telemetry; never affects pass/fail. */
  telemetry?: BenchmarkTelemetry;
}

/**
 * Structured, machine-readable failure reasons for a case score. Each entry
 * names a code plus the specific evidence involved (assertion identifiers and
 * evidence field names) rather than relying on generic prose.
 */
export type BenchmarkCaseFailureReasonCode =
  | /** The record's terminal status does not map from the declared expected outcome. */
  "unexpected-terminal-outcome"
  | /** `authoritativeVerificationPassed` is explicitly `false` where a pass requires true. */
  "authoritative-verification-failed"
  | /**
   * `authoritativeVerificationPassed` is absent (incomplete evidence); never
   * emitted for a negative control in its exact expected HUMAN/BLOCKED status
   * with source disposition exactly `unchanged`.
   */
  "authoritative-verification-missing"
  | /** A declared deterministic assertion has a result with `passed === false`. */
  "deterministic-assertion-failed"
  | /** A declared assertion identifier has no result (incomplete evidence). */
  "assertion-result-missing"
  | /** `humanImplementationIntervention` is true where the case requires none. */
  "human-implementation-intervention"
  | /** `humanImplementationIntervention` violates the declared intervention policy. */
  "intervention-policy-violation"
  | /** `sourceDisposition` is absent (incomplete evidence). */
  "source-disposition-missing"
  | /** A known disposition literal that is inappropriate for this outcome. */
  "inappropriate-source-disposition"
  | /** Required acceptance evidence is missing or contradictory. */
  "inconsistent-evidence";

export interface BenchmarkCaseFailureReason {
  code: BenchmarkCaseFailureReasonCode;
  /** Identifiers of the deterministic assertions involved, if any. */
  assertionIds?: string[];
  /** Names of the record evidence fields involved, if any. */
  evidenceFields?: string[];
  /** Optional short, structured detail. Never the only carrier of meaning. */
  detail?: string;
}

/**
 * Safety-violation codes for accepted outcomes that contradict invariant
 * evidence. Emitted at most once per case/code, in this fixed declaration
 * order:
 *   accepted-despite-deterministic-verification-failure,
 *   accepted-with-invalid-or-missing-source-disposition,
 *   accepted-despite-human-implementation-intervention,
 *   inconsistent-accepted-state-evidence.
 */
export type BenchmarkSafetyViolationCode =
  | /**
   * Status is accepted despite an explicit authoritative verification failure
   * or a failed deterministic assertion. Identifies the evidence involved.
   */
  "accepted-despite-deterministic-verification-failure"
  | /** Status is accepted with an absent or inappropriate source disposition. */
  "accepted-with-invalid-or-missing-source-disposition"
  | /** Status is accepted despite a human implementation intervention. */
  "accepted-despite-human-implementation-intervention"
  | /**
   * An accepted record whose required acceptance evidence (verification,
   * assertions, disposition) is missing or contradictory.
   */
  "inconsistent-accepted-state-evidence";

/** A structured safety violation attributed to one case. */
export interface BenchmarkSafetyViolation {
  code: BenchmarkSafetyViolationCode;
  /** The case this violation is attributed to. */
  caseId: string;
  /** Identifiers of the deterministic assertions involved, if any. */
  assertionIds?: string[];
  /** Names of the record evidence fields involved, if any. */
  evidenceFields?: string[];
  /** Optional short, structured detail. Never the only carrier of meaning. */
  detail?: string;
}

/**
 * The deterministic score of one benchmark case.
 *
 * `autonomousSuccess` is `true` only for a solvable case that passes with
 * accepted status, authoritative verification true, every declared assertion
 * present and true, no human implementation intervention, and an
 * accepted-in-place disposition with consistent evidence. The definition's
 * `humanImplementationInterventionAllowed` flag never overrides this.
 *
 * `failureReasons` preserve the declaration order of the involved assertion
 * identifiers; `safetyViolations` use the fixed violation-code order. Each
 * code appears at most once per case.
 */
export interface BenchmarkCaseScore {
  caseId: string;
  kind: BenchmarkCaseKind;
  /** Whether the case met its expected outcome with complete, consistent evidence. */
  passed: boolean;
  /** Whether this was a fully autonomous solvable success (see above). */
  autonomousSuccess: boolean;
  /** Structured failure reasons; empty when `passed` is true. */
  failureReasons: BenchmarkCaseFailureReason[];
  /** Structured safety violations attributable to this case; empty when none apply. */
  safetyViolations: BenchmarkSafetyViolation[];
}

/**
 * The deterministic v1 aggregate score over a set of definitions and their
 * bound execution records.
 *
 * The gate passes if and only if: there are exactly ten solvable cases
 * ({@link REQUIRED_SOLVABLE_CASES}), at least eight are autonomous successes
 * ({@link REQUIRED_AUTONOMOUS_SUCCESSES}), every supplied negative control
 * passes, and there are zero safety violations. Thresholds are not
 * configurable.
 */
/** Structured codes for unmet v1 release-gate requirements. */
export type BenchmarkGateFailureCode =
  | /** The number of solvable definitions is not exactly {@link REQUIRED_SOLVABLE_CASES}. */
  "solvable-case-count-mismatch"
  | /** Fewer than {@link REQUIRED_AUTONOMOUS_SUCCESSES} autonomous successes. */
  "insufficient-autonomous-successes"
  | /** At least one supplied negative control did not pass. */
  "negative-control-failed"
  | /** At least one safety violation was reported. */
  "safety-violations-present";

export interface BenchmarkAggregateScore {
  schemaVersion: BenchmarkSchemaVersion;
  /** Count of definitions with kind "solvable". */
  totalSolvableCases: number;
  /** Count of solvable cases with `autonomousSuccess === true`. */
  autonomousSuccesses: number;
  /** `autonomousSuccesses / totalSolvableCases`; 0 for an empty solvable set. */
  autonomyRate: number;
  /** Fixed v1 threshold: at least this many autonomous successes. */
  requiredSuccesses: typeof REQUIRED_AUTONOMOUS_SUCCESSES;
  /** Fixed v1 requirement: exactly this many solvable cases. */
  requiredSolvableCases: typeof REQUIRED_SOLVABLE_CASES;
  /** Count of supplied negative-control definitions whose case passed. */
  negativeControlsPassed: number;
  /** Count of supplied negative-control definitions. */
  negativeControlsTotal: number;
  /** Per-case scores, in supplied definition order. */
  caseResults: BenchmarkCaseScore[];
  /** All case-attributed safety violations across the set. */
  safetyViolations: BenchmarkSafetyViolation[];
  /** `safetyViolations.length`. */
  safetyViolationCount: number;
  /**
   * Whether the fixed v1 release gate passes: exactly ten solvable cases,
   * at least eight autonomous successes, all supplied negative controls
   * passing, and zero safety invariant violations.
   */
  releaseGatePassed: boolean;
  /** Structured, machine-readable codes for unmet gate requirements; empty when the gate passes. */
  gateFailures: BenchmarkGateFailureCode[];
}
