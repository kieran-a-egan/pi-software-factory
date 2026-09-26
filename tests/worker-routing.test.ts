import { describe, expect, it } from "vitest";
import {
  evaluateWorkerGateConfidence,
  WORKER_GATE_ROUTING_REASONS,
  type WorkerGatePhase,
  type WorkerGateRoutingEvidence,
} from "../src/worker-routing.js";
import type { WorkerGateDecision } from "../src/types.js";

type GateLike = Pick<WorkerGateDecision, "disposition" | "confidence">;

function evaluate(
  phase: WorkerGatePhase,
  gate: GateLike,
  minChoiceConfidence: number,
  authoritativeVerificationAfterWorker: boolean,
): WorkerGateRoutingEvidence {
  return evaluateWorkerGateConfidence({
    phase,
    gate,
    minChoiceConfidence,
    authoritativeVerificationAfterWorker,
  });
}

describe("evaluateWorkerGateConfidence: provisional-ready exception", () => {
  it("routes repair + ready + 0.570 + threshold 0.60 + verification true to provisional-ready", () => {
    const evidence = evaluate("repair", { disposition: "ready", confidence: 0.57 }, 0.6, true);

    expect(evidence.outcome).toBe("provisional-ready");
    expect(evidence.reason).toBe("authoritative-verification-next");
    expect(evidence.reason).toBe(WORKER_GATE_ROUTING_REASONS.provisionalReady);
    // Original confidence/threshold preserved unrounded.
    expect(evidence.confidence).toBe(0.57);
    expect(evidence.minChoiceConfidence).toBe(0.6);
    expect(evidence.phase).toBe("repair");
    expect(evidence.disposition).toBe("ready");
    expect(evidence.authoritativeVerificationAfterWorker).toBe(true);
  });

  it("does not return provisional-ready for repair + ready at or above threshold (either flag)", () => {
    for (const flag of [true, false] as const) {
      for (const confidence of [0.6, 0.6000001, 0.95]) {
        const evidence = evaluate("repair", { disposition: "ready", confidence }, 0.6, flag);
        expect(evidence.outcome).toBe("pass-through");
        expect(evidence.outcome).not.toBe("provisional-ready");
        expect(evidence.disposition).toBe("ready");
        expect(evidence.confidence).toBe(confidence);
      }
    }
  });
});

describe("evaluateWorkerGateConfidence: below-threshold human routing", () => {
  it("routes implementation + ready below threshold to human even when authoritative verification is true (both flag values)", () => {
    for (const flag of [true, false] as const) {
      const evidence = evaluate("implementation", { disposition: "ready", confidence: 0.42 }, 0.6, flag);
      expect(evidence.outcome).toBe("human");
      expect(evidence.reason).toBe(WORKER_GATE_ROUTING_REASONS.human);
      expect(evidence.authoritativeVerificationAfterWorker).toBe(flag);
    }
  });

  it("routes repair + ready below threshold with authoritative verification false to human", () => {
    const evidence = evaluate("repair", { disposition: "ready", confidence: 0.57 }, 0.6, false);
    expect(evidence.outcome).toBe("human");
    expect(evidence.reason).toBe(WORKER_GATE_ROUTING_REASONS.human);
  });

  it("routes repair + blocked and repair + invalid below threshold to human with either flag value", () => {
    for (const disposition of ["blocked", "invalid"] as const) {
      for (const flag of [true, false] as const) {
        const evidence = evaluate("repair", { disposition, confidence: 0.3 }, 0.6, flag);
        expect(evidence.outcome).toBe("human");
        expect(evidence.outcome).not.toBe("provisional-ready");
        expect(evidence.disposition).toBe(disposition);
      }
    }
  });

  it("routes repair + continue below threshold to human (both flag values)", () => {
    for (const flag of [true, false] as const) {
      const evidence = evaluate("repair", { disposition: "continue", confidence: 0.55 }, 0.6, flag);
      expect(evidence.outcome).toBe("human");
      expect(evidence.disposition).toBe("continue");
    }
  });

  it("routes repair + continue at/above threshold to pass-through for existing bounded continuation (both flag values)", () => {
    for (const flag of [true, false] as const) {
      for (const confidence of [0.6, 0.72]) {
        const evidence = evaluate("repair", { disposition: "continue", confidence }, 0.6, flag);
        expect(evidence.outcome).toBe("pass-through");
        expect(evidence.outcome).not.toBe("provisional-ready");
        // Disposition is never rewritten: it is echoed unchanged.
        expect(evidence.disposition).toBe("continue");
      }
    }
  });
});

describe("evaluateWorkerGateConfidence: at/above-threshold pass-through scope", () => {
  it("passes at/above-threshold blocked/invalid results through to existing downstream handling (confidence-only scope)", () => {
    for (const disposition of ["blocked", "invalid"] as const) {
      for (const flag of [true, false] as const) {
        const evidence = evaluate("repair", { disposition, confidence: 0.9 }, 0.6, flag);
        expect(evidence.outcome).toBe("pass-through");
        expect(evidence.reason).toBe(WORKER_GATE_ROUTING_REASONS.passThrough);
        expect(evidence.disposition).toBe(disposition);
      }
    }
  });

  it("passes at/above-threshold implementation + ready through (both flag values)", () => {
    for (const flag of [true, false] as const) {
      const evidence = evaluate("implementation", { disposition: "ready", confidence: 0.6 }, 0.6, flag);
      expect(evidence.outcome).toBe("pass-through");
      expect(evidence.disposition).toBe("ready");
    }
  });
});

describe("evaluateWorkerGateConfidence: threshold and mutation guarantees", () => {
  it("uses a supplied non-default threshold without hard-coding 0.60", () => {
    // 0.57 is below a 0.55 threshold => pass-through, proving the threshold comes from input.
    const above = evaluate("repair", { disposition: "ready", confidence: 0.57 }, 0.55, true);
    expect(above.outcome).toBe("pass-through");
    expect(above.minChoiceConfidence).toBe(0.55);

    // 0.57 is below a 0.75 threshold => provisional-ready (repair exception) with the non-default threshold.
    const below = evaluate("repair", { disposition: "ready", confidence: 0.57 }, 0.75, true);
    expect(below.outcome).toBe("provisional-ready");
    expect(below.minChoiceConfidence).toBe(0.75);

    // And the same inputs against the default 0.60 threshold.
    const defaultThreshold = evaluate("repair", { disposition: "ready", confidence: 0.57 }, 0.6, true);
    expect(defaultThreshold.outcome).toBe("provisional-ready");
    expect(defaultThreshold.minChoiceConfidence).toBe(0.6);
  });

  it("does not mutate its inputs", () => {
    const input = {
      phase: "repair" as const,
      gate: { disposition: "ready", confidence: 0.57 } as GateLike,
      minChoiceConfidence: 0.6,
      authoritativeVerificationAfterWorker: true,
    };
    const gateSnapshot = { ...input.gate };

    const evidence = evaluateWorkerGateConfidence(input);
    expect(evidence.outcome).toBe("provisional-ready");

    expect(input.phase).toBe("repair");
    expect(input.gate).toEqual(gateSnapshot);
    expect(input.minChoiceConfidence).toBe(0.6);
    expect(input.authoritativeVerificationAfterWorker).toBe(true);
    // Evidence echoes the original values; it does not round or re-disposition.
    expect(evidence.confidence).toBe(gateSnapshot.confidence);
    expect(evidence.disposition).toBe(gateSnapshot.disposition);
  });
});
