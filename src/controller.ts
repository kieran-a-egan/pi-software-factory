import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative } from "node:path";
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
  checkpointContinuationPrompt,
  implementerPrompt,
  repairPrompt,
  reviewerPrompt,
  scoutPrompt,
  rescoutPrompt,
  replanPrompt,
  workerContinuationPrompt,
} from "./prompts.js";
import {
  applyWorktreePatch,
  captureWorktreeChange,
  changedPathsOutsideExpected,
  createIsolatedWorktree,
  createWorkingTreeSnapshot,
  pathsOverlap,
  removeIsolatedWorktree,
} from "./parallel.js";
import { createRunStore } from "./storage.js";
import type {
  FactoryConfig,
  FactoryDecisionRecord,
  FactoryProgressEvent,
  FactoryRunState,
  ImplementationUnit,
  ReviewResult,
  ScoutResult,
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
    rescoutPasses: state.rescoutPasses,
    replanPasses: state.replanPasses,
    planGatePasses: state.planGatePasses,
    checkpointCount: state.checkpoints?.length ?? 0,
    workerContinuationCount: state.workerContinuations?.length ?? 0,
    parallelBatchCount: state.parallelBatches?.length ?? 0,
    decisionCount: state.decisions?.length ?? 0,
    stageCount: telemetry.length,
    totalStageDurationMs: telemetry.reduce((sum, stage) => sum + stage.durationMs, 0),
    tokens,
    estimatedCost: telemetry.reduce((sum, stage) => sum + (stage.cost ?? 0), 0),
    stages: telemetry,
  };
}


function mergeScoutResults(base: ScoutResult, supplemental: ScoutResult): ScoutResult {
  const uniqueStrings = (values: string[]) => [...new Set(values)];
  const fileMap = new Map(base.files.map((item) => [item.path, item]));
  for (const item of supplemental.files) fileMap.set(item.path, item);
  const symbolMap = new Map(base.symbols.map((item) => [`${item.path}::${item.name}`, item]));
  for (const item of supplemental.symbols) symbolMap.set(`${item.path}::${item.name}`, item);

  return {
    summary: `${base.summary}\n\nAdditional evidence: ${supplemental.summary}`,
    files: [...fileMap.values()],
    symbols: [...symbolMap.values()],
    relationships: uniqueStrings([...base.relationships, ...supplemental.relationships]),
    constraints: uniqueStrings([...base.constraints, ...supplemental.constraints]),
    tests: uniqueStrings([...base.tests, ...supplemental.tests]),
    unknowns: supplemental.unknowns,
    recommendedReads: uniqueStrings([...base.recommendedReads, ...supplemental.recommendedReads]),
  };
}

function repoRelativeRunRoot(cwd: string, runRoot: string): string[] {
  if (!isAbsolute(runRoot)) return [runRoot.replace(/\\/g, "/")];
  const rel = relative(cwd, runRoot).replace(/\\/g, "/");
  if (!rel || rel === "." || rel.startsWith("../") || rel === "..") return [];
  return [rel];
}

function unexpectedReportedFiles(assignment: unknown, report: WorkerReport): string[] {
  const filesExpected = (assignment as any)?.filesExpected;
  if (!Array.isArray(filesExpected) || filesExpected.length === 0) return [];

  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/^\.\//, "");
  const allowed = filesExpected.map((value: unknown) => normalize(String(value)));
  return report.changedFiles
    .map(normalize)
    .filter((path) => !allowed.some((expected: string) => pathsOverlap(path, expected)));
}


function implementationGraphIssue(units: ImplementationUnit[]): string | undefined {
  const ids = new Set<string>();
  for (const unit of units) {
    if (ids.has(unit.id)) return `duplicate implementation unit id: ${unit.id}`;
    ids.add(unit.id);
  }

  for (const unit of units) {
    for (const dependency of unit.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        return `implementation unit ${unit.id} depends on unknown unit ${dependency}`;
      }
    }
  }

  const remaining = new Set(units.map((unit) => unit.id));
  const resolved = new Set<string>();
  while (remaining.size > 0) {
    const ready = units.filter(
      (unit) =>
        remaining.has(unit.id) &&
        (unit.dependsOn ?? []).every((dependency) => resolved.has(dependency)),
    );
    if (ready.length === 0) {
      return `implementation dependency graph contains a cycle involving: ${[...remaining].join(", ")}`;
    }
    for (const unit of ready) {
      remaining.delete(unit.id);
      resolved.add(unit.id);
    }
  }

  return undefined;
}

function readyImplementationUnits(
  units: ImplementationUnit[],
  pending: Set<string>,
  completed: Set<string>,
): ImplementationUnit[] {
  return units.filter(
    (unit) =>
      pending.has(unit.id) &&
      (unit.dependsOn ?? []).every((dependency) => completed.has(dependency)),
  );
}

function selectParallelUnits(
  ready: ImplementationUnit[],
  maxParallelUnits: number,
): ImplementationUnit[] {
  const selected: ImplementationUnit[] = [];

  for (const unit of ready) {
    if (!unit.filesExpected?.length || !Array.isArray(unit.dependsOn)) continue;

    const overlaps = selected.some((other) =>
      unit.filesExpected!.some((path) =>
        other.filesExpected!.some((otherPath) => pathsOverlap(path, otherPath)),
      ),
    );
    if (overlaps) continue;

    selected.push(unit);
    if (selected.length >= maxParallelUnits) break;
  }

  return selected;
}

export async function runFactory(
  cwd: string,
  objective: string,
  config: FactoryConfig,
  progress: ProgressFn,
): Promise<FactoryRunState> {
  const resolvedRunRoot = resolveRunRoot(cwd, config);
  const runtimeStatusIgnores = repoRelativeRunRoot(cwd, resolvedRunRoot);
  const store = createRunStore(resolvedRunRoot);
  const id = store.dir.split(/[\\/]/).pop()!;
  const state: FactoryRunState = {
    id,
    createdAt: new Date().toISOString(),
    cwd,
    objective,
    phase: "initializing",
    repairPasses: 0,
    rescoutPasses: 0,
    replanPasses: 0,
    planGatePasses: 0,
    workerContinuations: [],
    parallelBatches: [],
    decisions: [],
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

  const recordDecision = (decision: FactoryDecisionRecord) => {
    (state.decisions ??= []).push(decision);
    store.appendDecision(decision);
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
    () => gitStatus(cwd, runtimeStatusIgnores),
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
    workerCwd?: string;
    abortSignal?: AbortSignal;
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
            cwd: input.workerCwd ?? cwd,
            model: config.qwen,
            systemPrompt: input.systemPrompt,
            prompt,
            modelRuntime,
            tools: writeTools(),
            validate: validateWorkerReport,
            contextBudget: config.contextBudget,
            validateCheckpoint: validateWorkerCheckpoint,
            maxRuntimeMs: config.workerMaxRuntimeMinutes * 60_000,
            abortSignal: input.abortSignal,
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
        if (message.includes("exceeded max runtime")) {
          state.finalStatus = "human";
          state.finalReason = `Qwen worker timed out for ${input.label}: ${message}`;
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

      prompt = checkpointContinuationPrompt(input.basePrompt, segment.checkpoint);
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
    if (input.phase === "implementation") {
      const unexpectedFiles = unexpectedReportedFiles(input.assignment, input.report);
      if (unexpectedFiles.length > 0) {
        const violation = {
          phase: input.phase,
          label: input.label,
          filesExpected: (input.assignment as any)?.filesExpected ?? [],
          changedFiles: input.report.changedFiles,
          unexpectedFiles,
          at: new Date().toISOString(),
        };
        store.write(input.artifactName.replace(/\.json$/, "-scope-violation.json"), violation);
        recordDecision({ stage: "worker-scope", ...violation });
        state.finalStatus = "human";
        state.finalReason =
          `Worker reported edits outside the bounded file scope for ${input.label}: ${unexpectedFiles.join(", ")}.`;
        setPhase("human");
        return null;
      }
    }

    const gate = await runStage(
      { stage: "jev-worker-gate", label: input.label, actor: "jev", model: config.jev.model },
      () => jev.gateWorker({
        phase: input.phase,
        assignment: input.assignment,
        report: input.report,
        deterministicFailures: input.deterministicFailures,
      }),
      (value) => jevExtras(value, config.jev.model),
    );

    state.workerGates ??= [];
    state.workerGates.push(gate);
    store.write(input.artifactName, gate);
    recordDecision({
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

    return gate;
  };

  const runBoundedWorkerAssignment = async (input: {
    phase: "implementation" | "repair";
    role: "implementer" | "repairer";
    stage: "qwen-implement" | "qwen-repair";
    label: string;
    assignment: unknown;
    artifactStem: string;
    gateArtifactStem: string;
    systemPrompt: string;
    basePrompt: string;
    deterministicFailures?: Array<{ command: string; output: string }>;
    collectImplementationReport?: boolean;
    workerCwd?: string;
    abortSignal?: AbortSignal;
  }): Promise<WorkerReport | null> => {
    let continuationPass = 0;
    let prompt = input.basePrompt;

    while (true) {
      const suffix = continuationPass === 0 ? "" : `-continue-${continuationPass}`;
      const workerLabel = continuationPass === 0
        ? input.label
        : `${input.label} · continue ${continuationPass}`;

      const worker = await runCheckpointedQwenWorker({
        role: input.role,
        stage: input.stage,
        label: workerLabel,
        artifactStem: `${input.artifactStem}${suffix}`,
        systemPrompt: input.systemPrompt,
        basePrompt: prompt,
        workerCwd: input.workerCwd,
        abortSignal: input.abortSignal,
      });
      if (!worker) return null;

      if (input.collectImplementationReport) state.workers!.push(worker);
      store.write(`${input.artifactStem}${suffix}.json`, worker);

      const gate = await gateWorkerReport({
        phase: input.phase,
        label: continuationPass === 0
          ? input.label
          : `${input.label} continuation ${continuationPass}`,
        assignment: input.assignment,
        report: worker,
        deterministicFailures: input.deterministicFailures,
        artifactName: `${input.gateArtifactStem}${suffix}.json`,
      });
      if (!gate) return null;

      if (gate.disposition === "ready") return worker;

      if (gate.disposition === "blocked" || gate.disposition === "invalid") {
        state.finalStatus = "human";
        state.finalReason = `Jev classified ${input.label} as ${gate.disposition}.`;
        setPhase("human");
        return null;
      }

      if (continuationPass >= config.maxWorkerContinuationPasses) {
        state.finalStatus = "human";
        state.finalReason =
          `Jev requested another continuation for ${input.label} after reaching maxWorkerContinuationPasses (${config.maxWorkerContinuationPasses}).`;
        setPhase("human");
        return null;
      }

      continuationPass += 1;
      const record = {
        phase: input.phase,
        label: input.label,
        pass: continuationPass,
        createdAt: new Date().toISOString(),
        priorDisposition: "continue" as const,
        priorConfidence: gate.confidence,
      };
      state.workerContinuations ??= [];
      state.workerContinuations.push(record);
      store.write(`continuation-${input.artifactStem}-${continuationPass}.json`, {
        ...record,
        previousReport: worker,
        gate,
      });
      recordDecision({
        stage: "worker-continuation",
        ...record,
        decision: gate,
      });
      store.writeState(state);

      prompt = workerContinuationPrompt({
        basePrompt: input.basePrompt,
        previousReport: worker,
        gate,
        pass: continuationPass,
      });
    }
  };

  state.intake = await runStage(
    { stage: "jev-intake", actor: "jev", model: config.jev.model },
    () => jev.classifyIntake(objective),
    (value) => jevExtras(value, config.jev.model),
  );
  store.write("intake.json", state.intake);
  recordDecision({ stage: "intake", at: new Date().toISOString(), decision: state.intake });

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

  const runPlanGate = async (label: string | undefined, artifactName: string) => {
    state.planGatePasses += 1;
    const gate = await runStage(
      { stage: "jev-plan-gate", label, actor: "jev", model: config.jev.model },
      () => jev.gatePlan({ objective, scout: state.scout!, architecture: state.architecture! }),
      (value) => jevExtras(value, config.jev.model),
    );
    state.planGate = gate;
    store.write(artifactName, gate);
    recordDecision({
      stage: "plan-gate",
      pass: state.planGatePasses,
      label,
      at: new Date().toISOString(),
      decision: gate,
    });
    return gate;
  };

  const reviseArchitecture = async (input: {
    label: string;
    artifactName: string;
    trigger: "rescout" | "replan";
    triggerPass: number;
    previousArchitecture: typeof state.architecture;
    gate: NonNullable<typeof state.planGate>;
  }) => {
    const run = await runStage(
      { stage: "astra-replan", label: input.label, actor: "astra", model: `${config.astra.provider}/${config.astra.model}` },
      () => runAgent({
        role: "architect",
        cwd,
        model: config.astra,
        systemPrompt: ARCHITECT_SYSTEM,
        prompt: replanPrompt({
          objective,
          intake: state.intake!,
          projectContext,
          evidence: state.scout!,
          previousArchitecture: input.previousArchitecture,
          planGate: input.gate,
          trigger: input.trigger,
          triggerPass: input.triggerPass,
          focus: input.trigger === "rescout" ? input.gate.rescoutFocus : input.gate.replanFocus,
        }),
        modelRuntime,
        tools: readOnlyTools(),
        validate: validateArchitecture,
      }),
      agentExtras,
    );
    state.architecture = run.result;
    store.write(input.artifactName, state.architecture);
  };

  await runPlanGate(undefined, "plan-gate.json");

  while (true) {
    const gate = state.planGate!;

    if (gate.confidence < config.jev.minChoiceConfidence) {
      return stop("human", `Jev plan gate confidence is below threshold: ${gate.confidence.toFixed(3)}.`);
    }

    if (gate.action === "proceed") {
      if (gate.planCompleteProbability < config.jev.minNoulProbability) {
        return stop(
          "human",
          `Jev selected proceed but plan completeness is below threshold: ${gate.planCompleteProbability.toFixed(3)}.`,
        );
      }
      break;
    }

    if (gate.action === "human") {
      return stop("human", "Jev plan gate requested human intervention.");
    }

    if (gate.action === "rescout") {
      if (state.rescoutPasses >= config.planningLoops.maxRescoutPasses) {
        return stop(
          "human",
          `Jev requested another rescout after reaching maxRescoutPasses (${config.planningLoops.maxRescoutPasses}).`,
        );
      }

      state.rescoutPasses += 1;
      const pass = state.rescoutPasses;
      const previousArchitecture = state.architecture;
      const supplementalRun = await runStage(
        { stage: "qwen-rescout", label: `pass ${pass} · ${gate.rescoutFocus}`, actor: "qwen", model: `${config.qwen.provider}/${config.qwen.model}` },
        () => runAgent({
          role: "scout",
          cwd,
          model: config.qwen,
          systemPrompt: SCOUT_SYSTEM,
          prompt: rescoutPrompt({
            objective,
            projectContext,
            focus: gate.rescoutFocus,
            planGate: gate,
            priorEvidence: state.scout!,
            previousArchitecture,
            pass,
          }),
          modelRuntime,
          tools: readOnlyTools(),
          validate: validateScout,
        }),
        agentExtras,
      );
      store.write(`evidence-rescout-${pass}.json`, supplementalRun.result);
      state.scout = mergeScoutResults(state.scout!, supplementalRun.result);
      store.write(`evidence-merged-${pass}.json`, state.scout);

      await reviseArchitecture({
        label: `after rescout ${pass}`,
        artifactName: `architecture-after-rescout-${pass}.json`,
        trigger: "rescout",
        triggerPass: pass,
        previousArchitecture,
        gate,
      });
      await runPlanGate(`after rescout ${pass}`, `plan-gate-after-rescout-${pass}.json`);
      continue;
    }

    if (gate.action === "replan") {
      if (state.replanPasses >= config.planningLoops.maxReplanPasses) {
        return stop(
          "human",
          `Jev requested another replan after reaching maxReplanPasses (${config.planningLoops.maxReplanPasses}).`,
        );
      }

      state.replanPasses += 1;
      const pass = state.replanPasses;
      const previousArchitecture = state.architecture;
      await reviseArchitecture({
        label: `pass ${pass} · ${gate.replanFocus}`,
        artifactName: `architecture-replan-${pass}.json`,
        trigger: "replan",
        triggerPass: pass,
        previousArchitecture,
        gate,
      });
      await runPlanGate(`after replan ${pass}`, `plan-gate-after-replan-${pass}.json`);
      continue;
    }
  }

  if (state.rescoutPasses > 0 || state.replanPasses > 0) {
    store.write("evidence-final.json", state.scout);
    store.write("architecture-final.json", state.architecture);
    store.write("plan-gate-final.json", state.planGate);
  }

  state.workers = [];
  state.workerGates = [];
  state.checkpoints = [];
  state.workerContinuations = [];
  state.parallelBatches = [];

  const implementationUnits = state.architecture.implementationUnits;
  const graphIssue = implementationGraphIssue(implementationUnits);
  store.write("implementation-graph.json", {
    parallelImplementation: config.parallelImplementation,
    units: implementationUnits.map((unit) => ({
      id: unit.id,
      dependsOn: unit.dependsOn ?? [],
      filesExpected: unit.filesExpected ?? [],
    })),
    issue: graphIssue ?? null,
  });
  if (graphIssue) {
    return stop("human", `Invalid implementation dependency graph: ${graphIssue}.`);
  }

  const pendingUnits = new Set(implementationUnits.map((unit) => unit.id));
  const completedUnits = new Set<string>();
  let parallelBatchIndex = 0;
  let parallelAvailable =
    config.parallelImplementation.enabled &&
    config.parallelImplementation.maxParallelUnits > 1;

  const buildImplementationPrompt = (
    unit: ImplementationUnit,
    executionMode: "primary-sequential" | "isolated-parallel-worktree",
    parallelPeerIds: Set<string> = new Set(),
  ) => {
    const otherUnits = implementationUnits
      .filter((other) => other.id !== unit.id)
      .map((other) => ({
        id: other.id,
        objective: other.objective,
        filesExpected: other.filesExpected,
        relation: completedUnits.has(other.id)
          ? "already-completed"
          : parallelPeerIds.has(other.id)
            ? "parallel-peer"
            : "deferred",
      }));

    return implementerPrompt({
      executionMode,
      projectContext,
      architectureSummary: state.architecture!.summary,
      architecturalDecisions: state.architecture!.architecturalDecisions,
      currentUnit: unit,
      otherUnits,
    });
  };

  const runSequentialImplementationUnit = async (unit: ImplementationUnit): Promise<boolean> => {
    const safeUnitId = unit.id.replace(/[^a-zA-Z0-9_.-]/g, "_");
    let beforeSnapshot: string | undefined;

    if (unit.filesExpected?.length) {
      try {
        beforeSnapshot = await createWorkingTreeSnapshot(cwd, runtimeStatusIgnores);
      } catch (error: any) {
        state.finalStatus = "human";
        state.finalReason =
          `Could not create a deterministic scope snapshot for implementation unit ${unit.id}: ${error?.message ?? String(error)}`;
        setPhase("human");
        return false;
      }
    }

    const worker = await runBoundedWorkerAssignment({
      phase: "implementation",
      role: "implementer",
      stage: "qwen-implement",
      label: `implementation unit ${unit.id}`,
      assignment: unit,
      artifactStem: `implementation-${safeUnitId}`,
      gateArtifactStem: `implementation-gate-${safeUnitId}`,
      systemPrompt: IMPLEMENTER_SYSTEM,
      basePrompt: buildImplementationPrompt(unit, "primary-sequential"),
      collectImplementationReport: true,
    });
    if (!worker) return false;

    if (beforeSnapshot && unit.filesExpected?.length) {
      const change = await captureWorktreeChange(
        cwd,
        beforeSnapshot,
        runtimeStatusIgnores,
      );
      const unexpectedPaths = changedPathsOutsideExpected(
        change.changedPaths,
        unit.filesExpected,
      );
      const reported = worker.changedFiles.map((path) => path.replace(/\\/g, "/"));
      const actualUnreported = change.changedPaths.filter(
        (path) => !reported.some((reportedPath) => pathsOverlap(path, reportedPath)),
      );
      const scopeEvidence = {
        unitId: unit.id,
        filesExpected: unit.filesExpected,
        reportedChangedFiles: worker.changedFiles,
        actualChangedPaths: change.changedPaths,
        actualUnreported,
        unexpectedPaths,
        beforeSnapshot,
        afterSnapshot: change.snapshotCommit,
        at: new Date().toISOString(),
      };
      store.write(`implementation-scope-${safeUnitId}.json`, scopeEvidence);

      if (unexpectedPaths.length > 0) {
        recordDecision({
          stage: "worker-scope-actual",
          ...scopeEvidence,
        });
        state.finalStatus = "human";
        state.finalReason =
          `Implementation unit ${unit.id} changed files outside its deterministic scope: ${unexpectedPaths.join(", ")}.`;
        setPhase("human");
        return false;
      }
    }

    return true;
  };

  while (pendingUnits.size > 0) {
    const ready = readyImplementationUnits(implementationUnits, pendingUnits, completedUnits);
    if (ready.length === 0) {
      return stop(
        "human",
        `No implementation unit is runnable; unresolved units: ${[...pendingUnits].join(", ")}.`,
      );
    }

    const parallelUnits = parallelAvailable
      ? selectParallelUnits(ready, config.parallelImplementation.maxParallelUnits)
      : [];

    if (parallelUnits.length < 2) {
      const unit = ready[0];
      if (!(await runSequentialImplementationUnit(unit))) return finish();
      pendingUnits.delete(unit.id);
      completedUnits.add(unit.id);
      continue;
    }

    parallelBatchIndex += 1;
    const batchLabel = `batch ${parallelBatchIndex}`;
    let snapshotCommit: string;

    try {
      snapshotCommit = await runStage(
        { stage: "parallel-snapshot", label: batchLabel, actor: "controller" },
        () => createWorkingTreeSnapshot(cwd, runtimeStatusIgnores),
      );
    } catch (error: any) {
      parallelAvailable = false;
      store.write(`parallel-batch-${parallelBatchIndex}-fallback.json`, {
        batch: parallelBatchIndex,
        unitIds: parallelUnits.map((unit) => unit.id),
        reason: error?.message ?? String(error),
        action: "fall-back-to-sequential",
      });
      continue;
    }

    const batchRecord = {
      index: parallelBatchIndex,
      unitIds: parallelUnits.map((unit) => unit.id),
      createdAt: new Date().toISOString(),
      snapshotCommit,
    };
    (state.parallelBatches ??= []).push(batchRecord);
    store.writeState(state);

    const peerIds = new Set(parallelUnits.map((unit) => unit.id));
    const abortControllers = parallelUnits.map(() => new AbortController());

    const abortPeers = (sourceIndex: number) => {
      abortControllers.forEach((controller, index) => {
        if (index !== sourceIndex && !controller.signal.aborted) controller.abort();
      });
    };

    const parallelResults = await Promise.all(
      parallelUnits.map(async (unit, index) => {
        const safeUnitId = unit.id.replace(/[^a-zA-Z0-9_.-]/g, "_");
        let worktree: Awaited<ReturnType<typeof createIsolatedWorktree>> | undefined;

        try {
          worktree = await createIsolatedWorktree(cwd, snapshotCommit, unit.id);
          const worker = await runBoundedWorkerAssignment({
            phase: "implementation",
            role: "implementer",
            stage: "qwen-implement",
            label: `implementation unit ${unit.id} · parallel batch ${parallelBatchIndex}`,
            assignment: unit,
            artifactStem: `implementation-${safeUnitId}`,
            gateArtifactStem: `implementation-gate-${safeUnitId}`,
            systemPrompt: IMPLEMENTER_SYSTEM,
            basePrompt: buildImplementationPrompt(
              unit,
              "isolated-parallel-worktree",
              peerIds,
            ),
            collectImplementationReport: true,
            workerCwd: worktree.dir,
            abortSignal: abortControllers[index].signal,
          });

          if (!worker) {
            abortPeers(index);
            return {
              ok: false as const,
              unitId: unit.id,
              error: state.finalReason ?? "worker stopped without a ready report",
            };
          }

          const change = await captureWorktreeChange(worktree.dir, snapshotCommit);
          const unexpectedPaths = changedPathsOutsideExpected(
            change.changedPaths,
            unit.filesExpected,
          );

          if (unexpectedPaths.length > 0) {
            const violation = {
              batch: parallelBatchIndex,
              unitId: unit.id,
              filesExpected: unit.filesExpected ?? [],
              changedPaths: change.changedPaths,
              unexpectedPaths,
              at: new Date().toISOString(),
            };
            store.write(`parallel-scope-violation-${safeUnitId}.json`, violation);
            recordDecision({ stage: "parallel-worker-scope", ...violation });
            state.finalStatus = "human";
            state.finalReason =
              `Parallel worker ${unit.id} changed files outside its isolated file scope: ${unexpectedPaths.join(", ")}.`;
            setPhase("human");
            abortPeers(index);
            return { ok: false as const, unitId: unit.id, error: state.finalReason };
          }

          return {
            ok: true as const,
            unit,
            worker,
            change,
          };
        } catch (error: any) {
          abortPeers(index);
          if (!abortControllers[index].signal.aborted && !state.finalStatus) {
            state.finalStatus = "human";
            state.finalReason =
              `Parallel implementation worker ${unit.id} failed: ${error?.message ?? String(error)}`;
            setPhase("human");
          }
          return {
            ok: false as const,
            unitId: unit.id,
            error: error?.message ?? String(error),
            cancelled: abortControllers[index].signal.aborted,
          };
        } finally {
          if (worktree) await removeIsolatedWorktree(cwd, worktree);
        }
      }),
    );

    const failures = parallelResults.filter((result) => !result.ok);
    if (failures.length > 0) {
      if (!state.finalStatus) {
        state.finalStatus = "human";
        state.finalReason =
          `Parallel implementation batch ${parallelBatchIndex} did not complete safely.`;
      }
      setPhase("human");
      store.write(`parallel-batch-${parallelBatchIndex}.json`, {
        ...batchRecord,
        outcome: "stopped",
        results: parallelResults,
      });
      return finish();
    }

    const successful = parallelResults.filter(
      (result): result is Extract<(typeof parallelResults)[number], { ok: true }> => result.ok,
    );

    for (let leftIndex = 0; leftIndex < successful.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < successful.length; rightIndex += 1) {
        const left = successful[leftIndex];
        const right = successful[rightIndex];
        const overlap = left.change.changedPaths.find((leftPath) =>
          right.change.changedPaths.some((rightPath) => pathsOverlap(leftPath, rightPath)),
        );
        if (overlap) {
          store.write(`parallel-batch-${parallelBatchIndex}.json`, {
            ...batchRecord,
            outcome: "scope-conflict",
            leftUnit: left.unit.id,
            rightUnit: right.unit.id,
            overlappingPath: overlap,
          });
          return stop(
            "human",
            `Parallel workers ${left.unit.id} and ${right.unit.id} produced overlapping changes at ${overlap}.`,
          );
        }
      }
    }

    const combinedPatch = successful
      .map((result) => result.change.patch)
      .filter((patch) => patch.trim())
      .join("\n");

    try {
      await runStage(
        { stage: "parallel-integrate", label: batchLabel, actor: "controller" },
        () => applyWorktreePatch(cwd, combinedPatch),
      );
    } catch (error: any) {
      store.write(`parallel-batch-${parallelBatchIndex}.json`, {
        ...batchRecord,
        outcome: "integration-failed",
        error: error?.message ?? String(error),
      });
      return stop(
        "human",
        `Parallel batch ${parallelBatchIndex} could not be integrated cleanly: ${error?.message ?? String(error)}`,
      );
    }

    store.write(`parallel-batch-${parallelBatchIndex}.json`, {
      ...batchRecord,
      outcome: "integrated",
      units: successful.map((result) => ({
        id: result.unit.id,
        changedPaths: result.change.changedPaths,
        snapshotCommit: result.change.snapshotCommit,
      })),
    });

    for (const unit of parallelUnits) {
      pendingUnits.delete(unit.id);
      completedUnits.add(unit.id);
    }
  }

  state.verification = await runStage(
    { stage: "verify", actor: "tools" },
    () => verify(cwd, config.verificationCommands, runtimeStatusIgnores),
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
    const repair = await runBoundedWorkerAssignment({
      phase: "repair",
      role: "repairer",
      stage: "qwen-repair",
      label: `deterministic repair ${state.repairPasses}`,
      assignment: repairAssignment,
      artifactStem: `repair-${state.repairPasses}`,
      gateArtifactStem: `repair-gate-${state.repairPasses}`,
      systemPrompt: REPAIRER_SYSTEM,
      basePrompt: repairBasePrompt,
      deterministicFailures,
    });
    if (!repair) return finish();

    verification = await runStage(
      { stage: "verify", label: `after deterministic repair ${state.repairPasses}`, actor: "tools" },
      () => verify(cwd, config.verificationCommands, runtimeStatusIgnores),
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
  recordDecision({ stage: "review-gate", at: new Date().toISOString(), decision: state.reviewGate });

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
    const repair = await runBoundedWorkerAssignment({
      phase: "repair",
      role: "repairer",
      stage: "qwen-repair",
      label: `review repair ${state.repairPasses}`,
      assignment: repairAssignment,
      artifactStem: `repair-${state.repairPasses}`,
      gateArtifactStem: `repair-gate-${state.repairPasses}`,
      systemPrompt: REPAIRER_SYSTEM,
      basePrompt: repairBasePrompt,
      deterministicFailures,
    });
    if (!repair) return finish();

    verification = await runStage(
      { stage: "verify", label: `after repair ${state.repairPasses}`, actor: "tools" },
      () => verify(cwd, config.verificationCommands, runtimeStatusIgnores),
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
    recordDecision({ stage: "review-gate", repairPass: state.repairPasses, at: new Date().toISOString(), decision: state.reviewGate });
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
