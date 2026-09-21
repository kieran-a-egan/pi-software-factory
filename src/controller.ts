import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadProjectContext } from "./context.js";
import { resolveRunRoot } from "./config.js";
import { JevDecisionEngine } from "./jev.js";
import {
  readOnlyTools,
  runAgent,
  runCheckpointableAgent,
  writeTools,
  type AgentRunMetrics,
} from "./agent-runner.js";
import {
  ARCHITECT_SYSTEM,
  IMPLEMENTER_SYSTEM,
  REPAIRER_SYSTEM,
  REVIEWER_SYSTEM,
  SCOUT_SYSTEM,
  architectPrompt,
  continuationPrompt,
  implementerPrompt,
  repairPrompt,
  reviewerPrompt,
  scoutPrompt,
} from "./prompts.js";
import { createRunStore } from "./storage.js";
import type {
  FactoryConfig,
  FactoryProgressEvent,
  FactoryRunState,
  ReviewResult,
  StageTelemetry,
  TokenUsageSnapshot,
  VerificationResult,
  WorkerGateDecision,
  WorkerReport,
} from "./types.js";
import {
  validateArchitecture,
  validateReview,
  validateScout,
  validateWorkerCheckpoint,
  validateWorkerReport,
} from "./validate.js";
import { gitStatus, verify } from "./verification.js";

export type ProgressFn = (event: FactoryProgressEvent) => void;

type TelemetryExtras = Partial<Pick<
  StageTelemetry,
  "model" | "tokens" | "cost" | "contextUsage" | "maxContextTokens" | "contextWindow" | "compactions" | "checkpointRequested"
>>;

function tokenSnapshotFromJev(value: any): TokenUsageSnapshot | undefined {
  const usage = value?.raw?.usage;
  if (!usage || typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") return undefined;
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: 0,
    cacheWrite: 0,
    total: usage.input_tokens + usage.output_tokens,
  };
}

function jevExtras(value: any, configuredModel: string): TelemetryExtras {
  return {
    model: value?.raw?.model ?? configuredModel,
    tokens: tokenSnapshotFromJev(value),
  };
}

function agentExtras<T extends { metrics: AgentRunMetrics }>(run: T): TelemetryExtras {
  return {
    model: run.metrics.model,
    tokens: run.metrics.tokens,
    cost: run.metrics.cost,
    contextUsage: run.metrics.contextUsage,
    maxContextTokens: run.metrics.maxContextTokens,
    contextWindow: run.metrics.contextWindow,
    compactions: run.metrics.compactions,
    checkpointRequested: run.metrics.checkpointRequested,
  };
}

function buildRunSummary(state: FactoryRunState) {
  const telemetry = state.telemetry ?? [];
  const tokens = telemetry.reduce<TokenUsageSnapshot>(
    (acc, stage) => {
      if (!stage.tokens) return acc;
      acc.input += stage.tokens.input;
      acc.output += stage.tokens.output;
      acc.cacheRead += stage.tokens.cacheRead;
      acc.cacheWrite += stage.tokens.cacheWrite;
      acc.total += stage.tokens.total;
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  );

  return {
    id: state.id,
    objective: state.objective,
    createdAt: state.createdAt,
    completedAt: new Date().toISOString(),
    finalStatus: state.finalStatus,
    finalReason: state.finalReason,
    repairPasses: state.repairPasses,
    checkpointCount: state.checkpoints?.length ?? 0,
    stageCount: telemetry.length,
    totalStageDurationMs: telemetry.reduce((sum, stage) => sum + stage.durationMs, 0),
    tokens,
    estimatedCost: telemetry.reduce((sum, stage) => sum + (stage.cost ?? 0), 0),
    stages: telemetry,
  };
}

export async function runFactory(
  cwd: string,
  objective: string,
  config: FactoryConfig,
  progress: ProgressFn,
): Promise<FactoryRunState> {
  const store = createRunStore(resolveRunRoot(cwd, config));
  const id = store.dir.split(/[\\/]/).pop()!;
  const state: FactoryRunState = {
    id,
    createdAt: new Date().toISOString(),
    cwd,
    objective,
    phase: "initializing",
    repairPasses: 0,
    telemetry: [],
  };

  const setPhase = (phase: string) => {
    state.phase = phase;
    store.writeState(state);
  };

  const persistTelemetry = () => {
    store.write("telemetry.json", state.telemetry ?? []);
    store.writeState(state);
  };

  const runStage = async <T>(
    meta: { stage: string; label?: string; actor: StageTelemetry["actor"]; model?: string },
    operation: () => Promise<T>,
    extras?: (value: T) => TelemetryExtras,
  ): Promise<T> => {
    setPhase(meta.stage);
    progress({ type: "started", ...meta });
    const startedAt = new Date();

    try {
      const value = await operation();
      const endedAt = new Date();
      const telemetry: StageTelemetry = {
        ...meta,
        ...extras?.(value),
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime(),
        outcome: "completed",
      };
      state.telemetry!.push(telemetry);
      persistTelemetry();
      progress({ type: "completed", telemetry });
      return value;
    } catch (error: any) {
      const endedAt = new Date();
      const telemetry: StageTelemetry = {
        ...meta,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime(),
        outcome: "failed",
        error: error?.message ?? String(error),
      };
      state.telemetry!.push(telemetry);
      persistTelemetry();
      progress({ type: "completed", telemetry });
      throw error;
    }
  };

  const finish = () => {
    store.write("run-summary.json", buildRunSummary(state));
    store.writeState(state);
    return state;
  };

  const stop = (status: NonNullable<FactoryRunState["finalStatus"]>, reason: string) => {
    state.finalStatus = status;
    state.finalReason = reason;
    setPhase(status);
    return finish();
  };

  store.write("request.json", { objective, cwd, createdAt: state.createdAt });

  const beforeStatus = await runStage(
    { stage: "preflight", actor: "controller" },
    () => gitStatus(cwd),
  );
  store.write("preflight.json", { gitStatus: beforeStatus });
  if (config.requireCleanWorkingTree && beforeStatus.trim()) {
    return stop("blocked", "Working tree is not clean; factory is configured to require a clean tree.");
  }

  if (!process.env.TYPESAFE_API_KEY) {
    return stop("blocked", "TYPESAFE_API_KEY is not set.");
  }

  const modelRuntime = await ModelRuntime.create();
  const jev = new JevDecisionEngine(config);
  const projectContext = loadProjectContext(cwd, config.contextPaths, config.contextMaxBytes);
  store.write("project-context.json", { content: projectContext });

  const runCheckpointedQwenWorker = async (input: {
    role: "implementer" | "repairer";
    stage: "qwen-implement" | "qwen-repair";
    label: string;
    artifactStem: string;
    systemPrompt: string;
    basePrompt: string;
  }): Promise<WorkerReport | null> => {
    let prompt = input.basePrompt;
    let checkpointCount = 0;

    while (true) {
      const segmentLabel = checkpointCount === 0
        ? input.label
        : `${input.label} · resume ${checkpointCount}`;

      let segment;
      try {
        segment = await runStage(
          {
            stage: input.stage,
            label: segmentLabel,
            actor: "qwen",
            model: `${config.qwen.provider}/${config.qwen.model}`,
          },
          () => runCheckpointableAgent({
            role: input.role,
            cwd,
            model: config.qwen,
            systemPrompt: input.systemPrompt,
            prompt,
            modelRuntime,
            tools: writeTools(),
            validate: validateWorkerReport,
            contextBudget: config.contextBudget,
            validateCheckpoint: validateWorkerCheckpoint,
            onContext: (level, usage) => {
              progress({
                type: "context",
                stage: input.stage,
                label: segmentLabel,
                level,
                usage,
              });
            },
          }),
          agentExtras,
        );
      } catch (error: any) {
        const message = error?.message ?? String(error);
        if (message.includes("context checkpoint threshold")) {
          state.finalStatus = "human";
          state.finalReason = `Qwen context checkpoint failed for ${input.label}: ${message}`;
          setPhase("human");
          return null;
        }
        throw error;
      }

      if (segment.kind === "result") return segment.result;

      checkpointCount += 1;
      const record = {
        stage: input.stage,
        label: input.label,
        index: checkpointCount,
        createdAt: new Date().toISOString(),
        context: segment.context,
        checkpoint: segment.checkpoint,
      };
      state.checkpoints ??= [];
      state.checkpoints.push(record);
      store.write(`checkpoint-${input.artifactStem}-${checkpointCount}.json`, record);
      store.writeState(state);
      progress({
        type: "checkpoint-saved",
        stage: input.stage,
        label: input.label,
        index: checkpointCount,
        usage: segment.context,
      });

      if (checkpointCount > config.contextBudget.maxCheckpointsPerStage) {
        state.finalStatus = "human";
        state.finalReason =
          `Qwen exceeded maxCheckpointsPerStage (${config.contextBudget.maxCheckpointsPerStage}) for ${input.label}.`;
        setPhase("human");
        return null;
      }

      prompt = continuationPrompt(input.basePrompt, segment.checkpoint);
    }
  };

  const gateWorkerReport = async (input: {
    phase: "implementation" | "repair";
    label: string;
    assignment: unknown;
    report: WorkerReport;
    deterministicFailures?: Array<{ command: string; output: string }>;
    artifactName: string;
  }): Promise<WorkerGateDecision | null> => {
    const gate = await runStage(
      { stage: "jev-worker-gate", label: input.label, actor: "jev", model: config.jev.model },
      () => jev.gateWorker({
        phase: input.phase,
        objective,
        assignment: input.assignment,
        report: input.report,
        deterministicFailures: input.deterministicFailures,
      }),
      (value) => jevExtras(value, config.jev.model),
    );

    state.workerGates ??= [];
    state.workerGates.push(gate);
    store.write(input.artifactName, gate);
    store.appendDecision({
      stage: "worker-gate",
      phase: input.phase,
      label: input.label,
      at: new Date().toISOString(),
      decision: gate,
    });

    if (gate.confidence < config.jev.minChoiceConfidence) {
      state.finalStatus = "human";
      state.finalReason = `Jev worker gate confidence is below threshold for ${input.label}: ${gate.confidence.toFixed(3)}.`;
      setPhase("human");
      return null;
    }

    if (gate.disposition !== "ready") {
      state.finalStatus = "human";
      state.finalReason = `Jev classified ${input.label} as ${gate.disposition}. v0.3 stops rather than auto-continuing worker work.`;
      setPhase("human");
      return null;
    }

    return gate;
  };

  state.intake = await runStage(
    { stage: "jev-intake", actor: "jev", model: config.jev.model },
    () => jev.classifyIntake(objective),
    (value) => jevExtras(value, config.jev.model),
  );
  store.write("intake.json", state.intake);
  store.appendDecision({ stage: "intake", at: new Date().toISOString(), decision: state.intake });

  if (state.intake.requirementClarity === "major_gaps" && state.intake.confidence.requirementClarity >= config.jev.minChoiceConfidence) {
    return stop("human", "Jev classified the requirement as having major gaps.");
  }

  const scoutRun = await runStage(
    { stage: "qwen-scout", actor: "qwen", model: `${config.qwen.provider}/${config.qwen.model}` },
    () => runAgent({
      role: "scout",
      cwd,
      model: config.qwen,
      systemPrompt: SCOUT_SYSTEM,
      prompt: scoutPrompt(objective, projectContext),
      modelRuntime,
      tools: readOnlyTools(),
      validate: validateScout,
    }),
    agentExtras,
  );
  state.scout = scoutRun.result;
  store.write("evidence.json", state.scout);

  const architectureRun = await runStage(
    { stage: "astra-architect", actor: "astra", model: `${config.astra.provider}/${config.astra.model}` },
    () => runAgent({
      role: "architect",
      cwd,
      model: config.astra,
      systemPrompt: ARCHITECT_SYSTEM,
      prompt: architectPrompt({ objective, intake: state.intake!, projectContext, evidence: state.scout! }),
      modelRuntime,
      tools: readOnlyTools(),
      validate: validateArchitecture,
    }),
    agentExtras,
  );
  state.architecture = architectureRun.result;
  store.write("architecture.json", state.architecture);

  state.planGate = await runStage(
    { stage: "jev-plan-gate", actor: "jev", model: config.jev.model },
    () => jev.gatePlan({ objective, scout: state.scout!, architecture: state.architecture! }),
    (value) => jevExtras(value, config.jev.model),
  );
  store.write("plan-gate.json", state.planGate);
  store.appendDecision({ stage: "plan-gate", at: new Date().toISOString(), decision: state.planGate });

  if (state.planGate.confidence < config.jev.minChoiceConfidence || state.planGate.planCompleteProbability < config.jev.minNoulProbability) {
    return stop("human", "Jev plan gate confidence/completeness is below configured thresholds.");
  }
  if (state.planGate.action !== "proceed") {
    return stop("human", `Plan gate requested ${state.planGate.action}; v0.3 stops rather than auto-looping plan/scout.`);
  }

  state.workers = [];
  state.workerGates = [];
  state.checkpoints = [];
  for (const unit of state.architecture.implementationUnits) {
    const safeUnitId = unit.id.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const basePrompt = implementerPrompt({
      objective,
      projectContext,
      architectureSummary: state.architecture!.summary,
      architecturalDecisions: state.architecture!.architecturalDecisions,
      unit,
    });
    const worker = await runCheckpointedQwenWorker({
      role: "implementer",
      stage: "qwen-implement",
      label: unit.id,
      artifactStem: `implementation-${safeUnitId}`,
      systemPrompt: IMPLEMENTER_SYSTEM,
      basePrompt,
    });
    if (!worker) return finish();
    state.workers.push(worker);
    store.write(`implementation-${safeUnitId}.json`, worker);

    const gate = await gateWorkerReport({
      phase: "implementation",
      label: `implementation unit ${unit.id}`,
      assignment: unit,
      report: worker,
      artifactName: `implementation-gate-${safeUnitId}.json`,
    });
    if (!gate) return finish();
  }

  state.verification = await runStage(
    { stage: "verify", actor: "tools" },
    () => verify(cwd, config.verificationCommands),
  );
  store.write("verification.json", state.verification);

  let review: ReviewResult;
  let verification: VerificationResult = state.verification;

  // Deterministic tools are authoritative. Failed compiler/test/lint checks route
  // directly to bounded repair. Jev classifies only whether the repair report is
  // ready to be re-verified; it cannot override deterministic check results.
  while (!verification.passed && state.repairPasses < config.maxRepairPasses) {
    state.repairPasses += 1;
    const deterministicFailures = verification.checks
      .filter((x) => !x.passed)
      .map((x) => ({ command: x.command, output: x.output }));

    const repairAssignment = {
      kind: "deterministic-verification-repair",
      pass: state.repairPasses,
      architecture: state.architecture,
      deterministicFailures,
    };

    const repairBasePrompt = repairPrompt({
      unitId: `verification-repair-${state.repairPasses}`,
      objective,
      architecture: state.architecture!,
      review: null,
      deterministicFailures,
    });
    const repair = await runCheckpointedQwenWorker({
      role: "repairer",
      stage: "qwen-repair",
      label: `deterministic pass ${state.repairPasses}`,
      artifactStem: `repair-${state.repairPasses}`,
      systemPrompt: REPAIRER_SYSTEM,
      basePrompt: repairBasePrompt,
    });
    if (!repair) return finish();
    store.write(`repair-${state.repairPasses}.json`, repair);

    const repairGate = await gateWorkerReport({
      phase: "repair",
      label: `deterministic repair ${state.repairPasses}`,
      assignment: repairAssignment,
      report: repair,
      deterministicFailures,
      artifactName: `repair-gate-${state.repairPasses}.json`,
    });
    if (!repairGate) return finish();

    verification = await runStage(
      { stage: "verify", label: `after deterministic repair ${state.repairPasses}`, actor: "tools" },
      () => verify(cwd, config.verificationCommands),
    );
    state.verification = verification;
    store.write(`verification-${state.repairPasses}.json`, verification);
  }

  const doReview = async (label?: string) => {
    const diffForReview = verification.diff.length > config.maxDiffCharsForReview
      ? `${verification.diff.slice(0, config.maxDiffCharsForReview)}\n\n[diff truncated; inspect repository files for remaining changes]`
      : verification.diff;

    const reviewRun = await runStage(
      { stage: "astra-review", label, actor: "astra", model: `${config.astra.provider}/${config.astra.model}` },
      () => runAgent({
        role: "reviewer",
        cwd,
        model: config.astra,
        systemPrompt: REVIEWER_SYSTEM,
        prompt: reviewerPrompt({
          objective,
          projectContext,
          architecture: state.architecture!,
          workers: state.workers!,
          verification: { ...verification, diff: diffForReview },
        }),
        modelRuntime,
        tools: readOnlyTools(),
        validate: validateReview,
      }),
      agentExtras,
    );
    return reviewRun.result;
  };

  review = await doReview();
  state.review = review;
  store.write("review.json", review);

  state.reviewGate = await runStage(
    { stage: "jev-review-gate", actor: "jev", model: config.jev.model },
    () => jev.gateReview({
      objective,
      architecture: state.architecture!,
      verification,
      review,
    }),
    (value) => jevExtras(value, config.jev.model),
  );
  store.write("review-gate.json", state.reviewGate);
  store.appendDecision({ stage: "review-gate", at: new Date().toISOString(), decision: state.reviewGate });

  while (
    state.reviewGate.action === "rework" &&
    state.reviewGate.confidence >= config.jev.minChoiceConfidence &&
    state.repairPasses < config.maxRepairPasses
  ) {
    state.repairPasses += 1;
    const deterministicFailures = verification.checks
      .filter((x) => !x.passed)
      .map((x) => ({ command: x.command, output: x.output }));

    const repairAssignment = {
      kind: "review-repair",
      pass: state.repairPasses,
      architecture: state.architecture,
      review,
      deterministicFailures,
    };

    const repairBasePrompt = repairPrompt({
      unitId: `review-repair-${state.repairPasses}`,
      objective,
      architecture: state.architecture!,
      review,
      deterministicFailures,
    });
    const repair = await runCheckpointedQwenWorker({
      role: "repairer",
      stage: "qwen-repair",
      label: `review pass ${state.repairPasses}`,
      artifactStem: `repair-${state.repairPasses}`,
      systemPrompt: REPAIRER_SYSTEM,
      basePrompt: repairBasePrompt,
    });
    if (!repair) return finish();
    store.write(`repair-${state.repairPasses}.json`, repair);

    const repairGate = await gateWorkerReport({
      phase: "repair",
      label: `review repair ${state.repairPasses}`,
      assignment: repairAssignment,
      report: repair,
      deterministicFailures,
      artifactName: `repair-gate-${state.repairPasses}.json`,
    });
    if (!repairGate) return finish();

    verification = await runStage(
      { stage: "verify", label: `after repair ${state.repairPasses}`, actor: "tools" },
      () => verify(cwd, config.verificationCommands),
    );
    state.verification = verification;
    store.write(`verification-${state.repairPasses}.json`, verification);

    review = await doReview(`after repair ${state.repairPasses}`);
    state.review = review;
    store.write(`review-${state.repairPasses}.json`, review);

    state.reviewGate = await runStage(
      { stage: "jev-review-gate", label: `after repair ${state.repairPasses}`, actor: "jev", model: config.jev.model },
      () => jev.gateReview({ objective, architecture: state.architecture!, verification, review }),
      (value) => jevExtras(value, config.jev.model),
    );
    store.write(`review-gate-${state.repairPasses}.json`, state.reviewGate);
    store.appendDecision({ stage: "review-gate", repairPass: state.repairPasses, at: new Date().toISOString(), decision: state.reviewGate });
  }

  if (
    state.reviewGate.action === "accept" &&
    state.reviewGate.confidence >= config.jev.minChoiceConfidence &&
    state.reviewGate.reviewSufficientProbability >= config.jev.minNoulProbability &&
    verification.passed
  ) {
    state.finalStatus = "accepted";
    state.finalReason = "Deterministic checks passed and Jev accepted the independently reviewed change.";
    setPhase("accepted");
  } else {
    state.finalStatus = "human";
    state.finalReason = `Final gate requires ${state.reviewGate.action}; confidence=${state.reviewGate.confidence.toFixed(3)}, reviewSufficient=${state.reviewGate.reviewSufficientProbability.toFixed(3)}, verificationPassed=${verification.passed}.`;
    setPhase("human");
  }

  return finish();
}
