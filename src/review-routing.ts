import type { ReviewGateDecision, ReviewResult } from "./types.js";

/** Final acceptance only; bounded rework remains owned by the controller. */
export function evaluateFinalReview(input: {
  gate: ReviewGateDecision;
  review: ReviewResult;
  verificationPassed: boolean;
  minChoiceConfidence: number;
  minNoulProbability: number;
}) {
  const { gate, review, verificationPassed, minChoiceConfidence, minNoulProbability } = input;
  const hasMajorOrCriticalFindings = review.findings.some(({ severity }) => severity === "major" || severity === "critical");
  const acceptanceEligible = gate.action === "accept" &&
    gate.confidence >= minChoiceConfidence && verificationPassed;
  const normal = acceptanceEligible && gate.reviewSufficientProbability >= minNoulProbability;
  const bounded = acceptanceEligible &&
    gate.reviewSufficientProbability < minNoulProbability &&
    gate.residualRisk === "low" && review.verdict === "clean" &&
    !hasMajorOrCriticalFindings;

  return {
    outcome: normal ? "normal-acceptance" as const
      : bounded ? "bounded-low-sufficiency-acceptance" as const : "human-fallback" as const,
    action: gate.action,
    confidence: gate.confidence,
    reviewSufficientProbability: gate.reviewSufficientProbability,
    residualRisk: gate.residualRisk,
    reviewVerdict: review.verdict,
    hasMajorOrCriticalFindings,
    verificationPassed,
    minChoiceConfidence,
    minNoulProbability,
  };
}

export type FinalReviewRoutingEvidence = ReturnType<typeof evaluateFinalReview>;
