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
        rescoutFocus: choice("If more repository evidence is needed, what is the primary evidence area to investigate next?", {
          none: "No additional repository evidence is needed",
          dependencies: "Dependencies, call sites, symbol relationships, or integration boundaries",
          tests: "Existing tests, fixtures, test infrastructure, or verification behavior",
          data_model: "Persistence, schemas, data flow, migrations, or domain models",
          interfaces: "Public APIs, internal contracts, types, protocols, or extension points",
          runtime_config: "Configuration, environment, build, deployment, or runtime wiring",
          security: "Authentication, authorization, secrets, trust boundaries, or security controls",
          other: "A repository-evidence gap outside the listed categories",
        }),
        replanFocus: choice("If the plan needs revision, what is the primary planning problem to fix?", {
          none: "No planning revision is needed",
          scope: "The plan is too broad, too narrow, or misses required work",
          sequencing: "Implementation units, dependencies, or ordering need revision",
          architecture: "The proposed design or integration approach needs revision",
          verification: "The verification strategy or acceptance coverage is inadequate",
          risk_controls: "Risk containment, rollout, security, or safety controls need revision",
          assumptions: "The plan relies on unsupported or fragile assumptions",
          other: "A planning problem outside the listed categories",
        }),
      },
    });

    return {
      action: response.answers.action.choice,
      implementationRisk: response.answers.implementationRisk.choice,
      planCompleteProbability: response.answers.planComplete.noul,
      rescoutFocus: response.answers.rescoutFocus.choice,
      replanFocus: response.answers.replanFocus.choice,
      confidence: response.answers.action.confidence,
      raw: response,
    };
  }

  async gateWorker(input: {
    phase: "implementation" | "repair";
    assignment: unknown;
    report: WorkerReport;
    deterministicFailures?: Array<{ command: string; output: string }>;
  }): Promise<WorkerGateDecision> {
    const state = {
      phase: input.phase,
      assignment: input.assignment,
      report: input.report,
      deterministicFailures: input.deterministicFailures,
    };

    const response = await this.client.systemOne({
      state,
      questions: {
        disposition: choice(
          "Classify this worker report for workflow routing. The assignment object defines the worker's bounded scope; the overall objective is background only. Judge whether this assignment is complete enough to leave this worker and continue factory orchestration. Do not require work that belongs to a later implementation unit, and do not judge final software correctness because later units, deterministic verification, and independent review still follow.",
          {
            ready: "The report coherently addresses the bounded assignment and no work remains inside this assignment. Work explicitly belonging to later implementation units does not prevent ready. Empty changedFiles is valid when no code change was actually required.",
            continue: "Concrete work remains inside this same bounded assignment and the same worker should continue before the factory advances.",
            blocked: "This bounded assignment cannot proceed because it requires external input, an unavailable dependency, permission, product decision, or architectural change.",
            invalid: "The report is materially inconsistent with the bounded assignment, lacks enough evidence to route safely, or does not describe the assigned work.",
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
        action: choice("Given the independent review and deterministic verification, what should happen next? Treat the review verdict and explicit acceptance criteria as primary routing evidence.", {
          accept: "Deterministic verification passed and the review identifies no unmet explicit acceptance criterion or material issue that should be fixed before acceptance. Non-blocking info/minor observations may remain.",
          rework: "The review identifies a concrete bounded implementation or test issue, including an unmet explicit acceptance criterion, that should be fixed before acceptance without changing the approved architecture.",
          replan: "The review identifies a deeper architectural, scope, sequencing, or planning problem that cannot be resolved as a bounded implementation repair.",
          human: "Residual ambiguity, product intent, policy, or risk cannot be safely resolved by bounded implementation or planning work.",
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
