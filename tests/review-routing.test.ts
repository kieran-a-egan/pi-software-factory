import { describe, expect, it } from "vitest";
import { evaluateFinalReview } from "../src/review-routing.js";
import type { ReviewGateDecision, ReviewResult } from "../src/types.js";

const gate: ReviewGateDecision = {
  action: "accept", confidence: 1, reviewSufficientProbability: 0.57,
  residualRisk: "low", raw: { original: "untouched Jev evidence" },
};
const review: ReviewResult = {
  summary: "clean", verdict: "clean", findings: [], requirementCoverage: [], testGaps: [],
};
const input = { gate, review, verificationPassed: true, minChoiceConfidence: 0.6, minNoulProbability: 0.65 };

describe("final review routing", () => {
  it("accepts the observed 1.000 / 0.570 / low-risk / clean case without rewriting evidence", () => {
    const before = structuredClone(input);
    const routing = evaluateFinalReview(input);
    expect(routing).toMatchObject({
      outcome: "bounded-low-sufficiency-acceptance", confidence: 1,
      reviewSufficientProbability: 0.57, minChoiceConfidence: 0.6, minNoulProbability: 0.65,
    });
    expect(input).toEqual(before);
  });

  it.each([0.65, 0.9, 1])("preserves normal acceptance at sufficiency %s", (probability) => {
    expect(evaluateFinalReview({ ...input, gate: { ...gate, confidence: 0.6, reviewSufficientProbability: probability } }).outcome)
      .toBe("normal-acceptance");
  });

  it("does not add exception-only conditions to normal acceptance", () => {
    expect(evaluateFinalReview({
      ...input, gate: { ...gate, residualRisk: "high", reviewSufficientProbability: 0.65 },
      review: { ...review, verdict: "changes_requested", findings: [{ severity: "major", title: "issue", explanation: "issue" }] },
    }).outcome).toBe("normal-acceptance");
  });

  it.each([0.57, 0.65, 1])("rejects low action confidence even at sufficiency %s", (probability) => {
    expect(evaluateFinalReview({ ...input, gate: { ...gate, confidence: 0.59999, reviewSufficientProbability: probability } }).outcome)
      .toBe("human-fallback");
  });

  it.each([0.57, 0.65, 1])("never accepts failing verification at sufficiency %s", (probability) => {
    expect(evaluateFinalReview({ ...input, verificationPassed: false, gate: { ...gate, reviewSufficientProbability: probability } }).outcome)
      .toBe("human-fallback");
  });

  it.each(["medium", "high", "critical"] as const)("does not use the exception for %s residual risk", (residualRisk) => {
    expect(evaluateFinalReview({ ...input, gate: { ...gate, residualRisk } }).outcome).toBe("human-fallback");
  });

  it.each(["changes_requested", "architectural_issue", "uncertain"] as const)("does not use the exception for verdict %s", (verdict) => {
    expect(evaluateFinalReview({ ...input, review: { ...review, verdict } }).outcome).toBe("human-fallback");
  });

  it.each(["major", "critical"] as const)("does not use the exception with %s findings, even when the verdict is clean", (severity) => {
    expect(evaluateFinalReview({ ...input, review: { ...review, findings: [{ severity, title: "issue", explanation: "issue" }] } }).outcome)
      .toBe("human-fallback");
  });

  it.each(["info", "minor"] as const)("permits nonblocking %s findings", (severity) => {
    expect(evaluateFinalReview({ ...input, review: { ...review, findings: [{ severity, title: "note", explanation: "note" }] } }).outcome)
      .toBe("bounded-low-sufficiency-acceptance");
  });

  it.each(["rework", "replan", "human"] as const)("never turns %s into acceptance", (action) => {
    for (const reviewSufficientProbability of [0.57, 1]) {
      expect(evaluateFinalReview({ ...input, gate: { ...gate, action, reviewSufficientProbability } }).outcome).toBe("human-fallback");
    }
  });

  it("uses both non-default thresholds exactly, including equality", () => {
    const custom = { ...input, minChoiceConfidence: 0.95, minNoulProbability: 0.9 };
    expect(evaluateFinalReview({ ...custom, gate: { ...gate, confidence: 0.94999 } }).outcome).toBe("human-fallback");
    expect(evaluateFinalReview({ ...custom, gate: { ...gate, confidence: 0.95, reviewSufficientProbability: 0.89999 } }).outcome)
      .toBe("bounded-low-sufficiency-acceptance");
    expect(evaluateFinalReview({ ...custom, gate: { ...gate, confidence: 0.95, reviewSufficientProbability: 0.9 } }).outcome)
      .toBe("normal-acceptance");
    expect(evaluateFinalReview({ ...input, minNoulProbability: 0.5 }).outcome).toBe("normal-acceptance");
  });
});
