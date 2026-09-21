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
import type { ModelRef, TokenUsageSnapshot } from "./types.js";

export type AgentRole = "scout" | "architect" | "implementer" | "reviewer" | "repairer";

export interface AgentRunMetrics {
  model: string;
  tokens: TokenUsageSnapshot;
  cost: number;
  contextUsage?: unknown;
}

export interface AgentRunResult<T> {
  result: T;
  metrics: AgentRunMetrics;
}

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

function resourceDir(): string {
  const dir = join(tmpdir(), "pi-software-factory-empty-resources");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function runAgent<T>(options: RunAgentOptions<T>): Promise<AgentRunResult<T>> {
  const model = options.modelRuntime.getModel(options.model.provider, options.model.model);
  if (!model) {
    throw new Error(
      `Model not found: ${options.model.provider}/${options.model.model}. ` +
      `Check ~/.pi/agent/models.json and .pi/software-factory.json.`,
    );
  }

  let submitted: unknown = undefined;
  const submitTool = defineTool({
    name: "submit_result",
    label: "Submit Result",
    description: "Submit the final structured artifact for this factory stage. Call exactly once when complete.",
    parameters: Type.Object({ result: Type.Any() }),
    execute: async (_toolCallId, params) => {
      submitted = params.result;
      return {
        content: [{ type: "text", text: "Result accepted. End the task now without further tool calls." }],
        details: {},
      };
    },
  });

  const settings = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
  });

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
    tools: [...options.tools, "submit_result"],
    customTools: [submitTool],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(options.cwd),
    settingsManager: settings,
  });

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      options.onText?.(event.assistantMessageEvent.delta);
    }
  });

  let metrics: AgentRunMetrics | undefined;
  try {
    await session.prompt(options.prompt);
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
    };
  } finally {
    unsubscribe();
    session.dispose();
  }

  if (submitted === undefined) {
    throw new Error(`${options.role} agent finished without calling submit_result`);
  }

  return {
    result: options.validate(submitted),
    metrics: metrics ?? {
      model: `${options.model.provider}/${options.model.model}`,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    },
  };
}

export function readOnlyTools(): string[] {
  return ["read", "grep", "find", "ls"];
}

export function writeTools(): string[] {
  const shell = process.platform === "win32" ? "powershell" : "bash";
  return ["read", shell, "edit", "write", "grep", "find", "ls"];
}
