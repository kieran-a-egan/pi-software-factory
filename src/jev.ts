import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type {
  ArchitectureResult,
  FactoryConfig,
  IntakeDecision,
  PlanGateDecision,
  ReviewGateDecision,
  ReviewResult,
  ScoutResult,
  VerificationResult,
  WorkerGateDecision,
  WorkerReport,
} from "./types.js";

export class JevDecisionEngine {
  private readonly client: TypeSafeClient;

  constructor(private readonly config: FactoryConfig) {
    this.client = new TypeSafeClient({ defaultModel: config.jev.model });
  }

  async classifyIntake(objective: string): Promise<IntakeDecision> {
    const response = await this.client.systemOne({
      state: { objective },
      questions: {
        taskType: choice("Classify the software-engineering request by its primary intent.", {
          feature: "Adds new product or technical behavior",
          bug: "Fixes incorrect existing behavior",
          refactor: "Changes implementation structure without intended behavior change",
          docs: "Primarily documentation",
          test: "Primarily tests or test infrastructure",
          ops: "Build, deployment, CI, tooling, or operational work",
          unknown: "The primary intent cannot be determined from the request",
        }),
        requirementClarity: choice("How clear and actionable is the stated requirement before repository investigation?", {
          clear: "The intended outcome is specific enough to investigate and plan",
          minor_gaps: "Some details are missing but repository evidence can likely resolve them",
          major_gaps: "Critical product intent or constraints are missing and should be clarified",
        }),
        statedRisk: choice("Based only on the stated request, classify the consequence of implementing it incorrectly.", {
          low: "Localized and readily reversible",
          medium: "Meaningful behavior change with contained blast radius",
          high: "Cross-cutting, security-sensitive, data-sensitive, or difficult to reverse",
          critical: "Could cause severe security, data-loss, compliance, or production impact",
        }),
      },
    });

    return {
      taskType: response.answers.taskType.choice,
      requirementClarity: response.answers.requirementClarity.choice,
      statedRisk: response.answers.statedRisk.choice,
      confidence: {
        taskType: response.answers.taskType.confidence,
        requirementClarity: response.answers.requirementClarity.confidence,
        statedRisk: response.answers.statedRisk.confidence,
      },
      raw: response,
    };
  }

  async gatePlan(input: {
    objective: string;
    scout: ScoutResult;
    architecture: ArchitectureResult;
  }): Promise<PlanGateDecision> {
    const response = await this.client.systemOne({
      state: input,
      questions: {
        action: choice("What should the software factory do next with this implementation plan?", {
          proceed: "The plan is sufficiently grounded and bounded for implementation",
          rescout: "Important repository evidence is missing; gather more evidence before planning again",
          replan: "The evidence is adequate but the plan itself needs architectural or planning revision",
          human: "The decision depends on product intent, policy, or risk that should be resolved by a human",
        }),
        implementationRisk: choice("Classify the implementation risk of executing this plan as written.", {
          low: "Localized, easy to verify, and readily reversible",
          medium: "Moderate blast radius or non-trivial integration risk",
          high: "Cross-cutting, security/data-sensitive, or difficult to reverse",
          critical: "Severe security, data-loss, compliance, or production risk",
        }),
        planComplete: noul("The plan covers the objective, relevant constraints, implementation units, and verification needed to execute safely."),
      },
    });

    return {
      action: response.answers.action.choice,
      implementationRisk: response.answers.implementationRisk.choice,
      planCompleteProbability: response.answers.planComplete.noul,
      confidence: response.answers.action.confidence,
      raw: response,
    };
  }

  async gateWorker(input: {
    phase: "implementation" | "repair";
    objective: string;
    assignment: unknown;
    report: WorkerReport;
    deterministicFailures?: Array<{ command: string; output: string }>;
  }): Promise<WorkerGateDecision> {
    const response = await this.client.systemOne({
      state: input,
      questions: {
        disposition: choice(
          "Classify this worker report for workflow routing. Judge whether the bounded assignment is ready to proceed to deterministic verification; do not judge final software correctness, because tests and independent review happen afterwards.",
          {
            ready: "The report coherently addresses the assigned work and is ready for deterministic verification. Empty changedFiles is valid when no code change was actually required.",
            continue: "The report indicates bounded implementation or repair work still remains and the worker should continue before verification.",
            blocked: "A concrete blocker requires external input, unavailable dependency, permission, product decision, or architectural change before the worker can proceed.",
            invalid: "The report is materially inconsistent with the assignment, lacks enough evidence to route safely, or does not describe the assigned work.",
          },
        ),
      },
    });

    return {
      disposition: response.answers.disposition.choice,
      confidence: response.answers.disposition.confidence,
      raw: response,
    };
  }

  async gateReview(input: {
    objective: string;
    architecture: ArchitectureResult;
    verification: VerificationResult;
    review: ReviewResult;
  }): Promise<ReviewGateDecision> {
    const state = {
      objective: input.objective,
      architectureSummary: input.architecture.summary,
      verification: {
        passed: input.verification.passed,
        checks: input.verification.checks.map((x) => ({ command: x.command, passed: x.passed })),
      },
      review: input.review,
    };

    const response = await this.client.systemOne({
      state,
      questions: {
        action: choice("Given the independent review and deterministic verification, what should happen next?", {
          accept: "The change can be accepted by the factory",
          rework: "The implementation has bounded issues that the implementation worker should fix",
          replan: "The implementation exposes a deeper architectural or planning problem",
          human: "Residual ambiguity or risk should be resolved by a human",
        }),
        residualRisk: choice("Classify the residual risk if the current change were accepted without further work.", {
          low: "No material unresolved issue is evident",
          medium: "Some uncertainty or contained issue remains",
          high: "Material correctness, security, data, or cross-cutting risk remains",
          critical: "Severe unresolved risk remains",
        }),
        reviewSufficient: noul("The review and verification evidence are sufficient to decide whether this change is ready."),
      },
    });

    return {
      action: response.answers.action.choice,
      residualRisk: response.answers.residualRisk.choice,
      reviewSufficientProbability: response.answers.reviewSufficient.noul,
      confidence: response.answers.action.confidence,
      raw: response,
    };
  }
}
