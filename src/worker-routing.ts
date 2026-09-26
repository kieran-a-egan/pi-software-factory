import type { WorkerGateDecision } from "./types.js";

/**
 * Worker-gate confidence routing policy.
 *
 * Pure, confidence-only helper: it routes a gate result by confidence against
 * the supplied threshold and never rewrites the gate disposition or
 * confidence. Pass-through means "defer to the existing disposition handling"
 * (Jev's downstream ready/continue/blocked/invalid logic), not acceptance.
 * There is deliberately no "accepted" outcome: neither provisional-ready nor
 * pass-through authorizes final acceptance on its own.
 */

export type WorkerGatePhase = "implementation" | "repair";

export type WorkerGateRoutingOutcome =
  | "human"
  | "provisional-ready"
  | "pass-through";

export interface WorkerGateRoutingEvidence {
  /** Discriminated routing outcome. */
  outcome: WorkerGateRoutingOutcome;
  /** Stable machine-readable reason for the outcome. */
  reason: string;
  /** Original gate confidence, unrounded. */
  confidence: number;
  /** Supplied threshold, unmodified. */
  minChoiceConfidence: number;
  phase: WorkerGatePhase;
  /** Original gate disposition, unmodified. */
  disposition: WorkerGateDecision["disposition"];
  authoritativeVerificationAfterWorker: boolean;
}

export const WORKER_GATE_ROUTING_REASONS = {
  /** Below-threshold result routed to human. */
  human: "confidence-below-threshold",
  /**
   * Repair-phase READY result below threshold, permitted to proceed only
   * because authoritative (deterministic + Jev final-acceptance)
   * verification runs after the worker.
   */
  provisionalReady: "authoritative-verification-next",
  /** At/above-threshold result defers to the existing disposition handling. */
  passThrough: "confidence-at-or-above-threshold",
} as const;

/**
 * Route a worker-gate result by confidence only.
 *
 * Exact four-part exception predicate for provisional-ready:
 *   phase === "repair"
 *   && gate.disposition === "ready"
 *   && gate.confidence < minChoiceConfidence (strict less-than)
 *   && authoritativeVerificationAfterWorker === true
 *
 * No I/O, configuration reads, timestamps, model calls, worker mutation, or
 * final-status assignment. Inputs are read but never mutated.
 */
export function evaluateWorkerGateConfidence(input: {
  phase: WorkerGatePhase;
  gate: Pick<WorkerGateDecision, "disposition" | "confidence">;
  minChoiceConfidence: number;
  authoritativeVerificationAfterWorker: boolean;
}): WorkerGateRoutingEvidence {
  const { phase, gate, minChoiceConfidence, authoritativeVerificationAfterWorker } = input;

  const belowThreshold = gate.confidence < minChoiceConfidence;
  const provisionalEligible =
    phase === "repair" &&
    gate.disposition === "ready" &&
    belowThreshold &&
    authoritativeVerificationAfterWorker === true;

  const outcome: WorkerGateRoutingOutcome = belowThreshold
    ? provisionalEligible
      ? "provisional-ready"
      : "human"
    : "pass-through";
  const reason = outcome === "provisional-ready"
    ? WORKER_GATE_ROUTING_REASONS.provisionalReady
    : outcome === "human"
      ? WORKER_GATE_ROUTING_REASONS.human
      : WORKER_GATE_ROUTING_REASONS.passThrough;

  return {
    outcome,
    reason,
    confidence: gate.confidence,
    minChoiceConfidence,
    phase,
    disposition: gate.disposition,
    authoritativeVerificationAfterWorker,
  };
}
