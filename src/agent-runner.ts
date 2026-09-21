import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  ContextBudgetConfig,
  ContextUsageSnapshot,
  ModelRef,
  TokenUsageSnapshot,
  WorkerCheckpoint,
} from "./types.js";

export type AgentRole = "scout" | "architect" | "implementer" | "reviewer" | "repairer";

export interface AgentRunMetrics {
  model: string;
  tokens: TokenUsageSnapshot;
  cost: number;
  contextUsage?: unknown;
  maxContextTokens?: number;
  contextWindow?: number;
  compactions?: number;
  checkpointRequested?: boolean;
}

export interface AgentRunResult<T> {
  result: T;
  metrics: AgentRunMetrics;
}

export type CheckpointableAgentRunResult<T> =
  | { kind: "result"; result: T; metrics: AgentRunMetrics }
  | { kind: "checkpoint"; checkpoint: WorkerCheckpoint; context: ContextUsageSnapshot; metrics: AgentRunMetrics };

export interface RunAgentOptions<T> {
  role: AgentRole;
  cwd: string;
  model: ModelRef;
  systemPrompt: string;
  prompt: string;
  modelRuntime: ModelRuntime;
  tools: string[];
  validate: (value: unknown) => T;
  onText?: (delta: string) => void;
}

export interface RunCheckpointableAgentOptions<T> extends RunAgentOptions<T> {
  contextBudget: ContextBudgetConfig;
  validateCheckpoint: (value: unknown) => WorkerCheckpoint;
  onContext?: (level: "warning" | "checkpoint", usage: ContextUsageSnapshot) => void;
}

function resourceDir(): string {
  const dir = join(tmpdir(), "pi-software-factory-empty-resources");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function normalizeContextUsage(raw: any, fallbackWindow?: number): ContextUsageSnapshot | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const tokens = [raw.tokens, raw.contextTokens, raw.usedTokens].find((x) => typeof x === "number");
  if (typeof tokens !== "number" || !Number.isFinite(tokens)) return undefined;

  const contextWindow = [raw.contextWindow, raw.window, fallbackWindow].find((x) => typeof x === "number") as
    | number
    | undefined;
  const percent = typeof raw.percent === "number"
    ? raw.percent
    : contextWindow && contextWindow > 0
      ? (tokens / contextWindow) * 100
      : undefined;

  return { tokens, contextWindow, percent };
}

function getContextUsage(session: any, fallbackWindow?: number): ContextUsageSnapshot | undefined {
  try {
    const direct = typeof session.getContextUsage === "function" ? session.getContextUsage() : undefined;
    const normalized = normalizeContextUsage(direct, fallbackWindow);
    if (normalized) return normalized;
  } catch {
    // Fall through to getSessionStats().contextUsage for older/newer SDK variants.
  }

  try {
    const stats = typeof session.getSessionStats === "function" ? session.getSessionStats() : undefined;
    return normalizeContextUsage(stats?.contextUsage, fallbackWindow);
  } catch {
    return undefined;
  }
}

function makeSettings(modelContextWindow?: number, budget?: ContextBudgetConfig) {
  let reserveTokens = 16_384;
  if (budget?.enabled && modelContextWindow && modelContextWindow > budget.hardLimitTokens) {
    // The factory checkpoint is the primary control. Pi auto-compaction remains a
    // last-resort safety net before the configured hard limit rather than racing the
    // checkpoint at 75K.
    reserveTokens = Math.max(16_384, modelContextWindow - budget.hardLimitTokens);
  }

  return SettingsManager.inMemory({
    compaction: {
      enabled: true,
      reserveTokens,
      keepRecentTokens: 20_000,
    },
    retry: { enabled: true, maxRetries: 2 },
  });
}

const CHECKPOINT_STEERING = `FACTORY CONTEXT BUDGET CHECKPOINT REQUIRED.
Stop normal implementation work at the next safe boundary. Do not perform further broad exploration.
If the assigned unit is already genuinely finished, call submit_result normally. Otherwise call submit_checkpoint exactly once with a compact factual continuation record using this shape:
{
  "unitId": string,
  "summary": string,
  "completedWork": string[],
  "changedFiles": string[],
  "decisions": string[],
  "verifiedFacts": string[],
  "remainingWork": string[],
  "blockers": string[],
  "relevantSymbols": string[],
  "nextAction": string
}
Do not put conversation history in the checkpoint. The factory will start a fresh worker session from it.`;

interface InternalRunOptions<T> extends RunAgentOptions<T> {
  contextBudget?: ContextBudgetConfig;
  validateCheckpoint?: (value: unknown) => WorkerCheckpoint;
  onContext?: (level: "warning" | "checkpoint", usage: ContextUsageSnapshot) => void;
}

async function runInternal<T>(options: InternalRunOptions<T>): Promise<{
  submitted?: T;
  checkpoint?: WorkerCheckpoint;
  checkpointContext?: ContextUsageSnapshot;
  metrics: AgentRunMetrics;
}> {
  const model = options.modelRuntime.getModel(options.model.provider, options.model.model);
  if (!model) {
    throw new Error(
      `Model not found: ${options.model.provider}/${options.model.model}. ` +
      `Check ~/.pi/agent/models.json and .pi/software-factory.json.`,
    );
  }

  let submittedRaw: unknown = undefined;
  let checkpointRaw: unknown = undefined;
  let checkpointContext: ContextUsageSnapshot | undefined;

  const submitTool = defineTool({
    name: "submit_result",
    label: "Submit Result",
    description: "Submit the final structured artifact for this factory stage. Call exactly once when complete.",
    parameters: Type.Object({ result: Type.Any() }),
    execute: async (_toolCallId, params) => {
      submittedRaw = params.result;
      return {
        content: [{ type: "text", text: "Result accepted. End the task now without further tool calls." }],
        details: {},
      };
    },
  });

  const customTools: any[] = [submitTool];
  const enabledTools = [...options.tools, "submit_result"];

  if (options.contextBudget?.enabled && options.validateCheckpoint) {
    const checkpointTool = defineTool({
      name: "submit_checkpoint",
      label: "Submit Checkpoint",
      description: "Submit compact factual continuation state when the factory requests a context-budget checkpoint.",
      parameters: Type.Object({ checkpoint: Type.Any() }),
      execute: async (_toolCallId, params) => {
        checkpointRaw = params.checkpoint;
        return {
          content: [{ type: "text", text: "Checkpoint accepted. End this worker session now." }],
          details: {},
        };
      },
    });
    customTools.push(checkpointTool);
    enabledTools.push("submit_checkpoint");
  }

  const modelContextWindow = typeof (model as any).contextWindow === "number" ? (model as any).contextWindow : undefined;
  if (
    options.contextBudget?.enabled &&
    modelContextWindow &&
    options.contextBudget.hardLimitTokens >= modelContextWindow
  ) {
    throw new Error(
      `contextBudget.hardLimitTokens (${options.contextBudget.hardLimitTokens}) must be below ` +
      `${options.model.provider}/${options.model.model} contextWindow (${modelContextWindow}).`,
    );
  }
  const settings = makeSettings(modelContextWindow, options.contextBudget);

  // Point subagents at an empty resource directory so they do not recursively
  // auto-load the software-factory package. Their tool cwd remains options.cwd.
  const empty = resourceDir();
  const loader = new DefaultResourceLoader({
    cwd: empty,
    agentDir: empty,
    settingsManager: settings,
    systemPromptOverride: () => options.systemPrompt,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: options.cwd,
    model,
    modelRuntime: options.modelRuntime,
    thinkingLevel: options.model.thinking,
    tools: enabledTools,
    customTools,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(options.cwd),
    settingsManager: settings,
  });

  let maxContextTokens = 0;
  let latestContext: ContextUsageSnapshot | undefined;
  let warningEmitted = false;
  let checkpointRequested = false;
  let steeringError: string | undefined;
  let compactions = 0;

  const inspectContext = () => {
    const usage = getContextUsage(session, modelContextWindow);
    if (!usage) return;
    latestContext = usage;
    maxContextTokens = Math.max(maxContextTokens, usage.tokens);

    const budget = options.contextBudget;
    if (!budget?.enabled) return;

    if (!warningEmitted && usage.tokens >= budget.warningTokens) {
      warningEmitted = true;
      options.onContext?.("warning", usage);
    }

    if (!checkpointRequested && submittedRaw === undefined && checkpointRaw === undefined && usage.tokens >= budget.checkpointTokens) {
      checkpointRequested = true;
      checkpointContext = usage;
      options.onContext?.("checkpoint", usage);
      void session.steer(CHECKPOINT_STEERING).catch((error: any) => {
        steeringError = error?.message ?? String(error);
      });
    }
  };

  const unsubscribe = session.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      options.onText?.(event.assistantMessageEvent.delta);
    }
    if (event.type === "turn_end" || event.type === "tool_execution_end" || event.type === "message_end") {
      inspectContext();
    }
    if (event.type === "compaction_end") {
      compactions += 1;
      inspectContext();
    }
  });

  let metrics: AgentRunMetrics | undefined;
  try {
    await session.prompt(options.prompt);
    inspectContext();
    const stats = session.getSessionStats();
    metrics = {
      model: `${options.model.provider}/${options.model.model}`,
      tokens: {
        input: stats.tokens.input,
        output: stats.tokens.output,
        cacheRead: stats.tokens.cacheRead,
        cacheWrite: stats.tokens.cacheWrite,
        total: stats.tokens.total,
      },
      cost: stats.cost,
      contextUsage: stats.contextUsage,
      maxContextTokens,
      contextWindow: latestContext?.contextWindow ?? modelContextWindow,
      compactions,
      checkpointRequested,
    };
  } finally {
    unsubscribe();
    session.dispose();
  }

  const fallbackMetrics: AgentRunMetrics = metrics ?? {
    model: `${options.model.provider}/${options.model.model}`,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    maxContextTokens,
    contextWindow: latestContext?.contextWindow ?? modelContextWindow,
    compactions,
    checkpointRequested,
  };

  if (submittedRaw !== undefined) {
    return { submitted: options.validate(submittedRaw), metrics: fallbackMetrics };
  }

  if (checkpointRaw !== undefined && options.validateCheckpoint) {
    const checkpoint = options.validateCheckpoint(checkpointRaw);
    return {
      checkpoint,
      checkpointContext: checkpointContext ?? latestContext ?? {
        tokens: maxContextTokens,
        contextWindow: modelContextWindow,
        percent: modelContextWindow ? (maxContextTokens / modelContextWindow) * 100 : undefined,
      },
      metrics: fallbackMetrics,
    };
  }

  if (checkpointRequested) {
    throw new Error(
      `${options.role} reached the context checkpoint threshold but did not call submit_checkpoint` +
      (steeringError ? ` (checkpoint steering failed: ${steeringError})` : ""),
    );
  }

  throw new Error(`${options.role} agent finished without calling submit_result`);
}

export async function runAgent<T>(options: RunAgentOptions<T>): Promise<AgentRunResult<T>> {
  const outcome = await runInternal(options);
  if (outcome.submitted === undefined) {
    throw new Error(`${options.role} unexpectedly returned a checkpoint in a non-checkpointable stage`);
  }
  return { result: outcome.submitted, metrics: outcome.metrics };
}

export async function runCheckpointableAgent<T>(
  options: RunCheckpointableAgentOptions<T>,
): Promise<CheckpointableAgentRunResult<T>> {
  const outcome = await runInternal(options);
  if (outcome.submitted !== undefined) {
    return { kind: "result", result: outcome.submitted, metrics: outcome.metrics };
  }
  if (outcome.checkpoint && outcome.checkpointContext) {
    return {
      kind: "checkpoint",
      checkpoint: outcome.checkpoint,
      context: outcome.checkpointContext,
      metrics: outcome.metrics,
    };
  }
  throw new Error(`${options.role} produced neither a result nor a checkpoint`);
}

export function readOnlyTools(): string[] {
  return ["read", "grep", "find", "ls"];
}

export function writeTools(): string[] {
  const shell = process.platform === "win32" ? "powershell" : "bash";
  return ["read", shell, "edit", "write", "grep", "find", "ls"];
}
