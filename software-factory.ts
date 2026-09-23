import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { loadConfig } from "./src/config.js";
import { runFactory } from "./src/controller.js";
import type { ContextUsageSnapshot, FactoryProgressEvent, FactoryRunState, StageTelemetry, TokenUsageSnapshot } from "./src/types.js";

const VERSION = "0.6.0";
const ENTRY_TYPE = "software-factory";

type TranscriptEntry =
  | {
      kind: "run-start";
      version: string;
      objective: string;
      startedAt: string;
    }
  | {
      kind: "stage";
      telemetry: StageTelemetry;
    }
  | {
      kind: "context";
      stage: string;
      label?: string;
      level: "warning" | "checkpoint";
      usage: ContextUsageSnapshot;
    }
  | {
      kind: "checkpoint-saved";
      stage: string;
      label?: string;
      index: number;
      usage: ContextUsageSnapshot;
    }
  | {
      kind: "run-final";
      version: string;
      state: FactoryRunState;
    }
  | {
      kind: "run-error";
      version: string;
      objective: string;
      error: string;
    }
  | {
      kind: "status";
      version: string;
      objective: string;
      state?: FactoryRunState;
      stages: StageTelemetry[];
      runningStage?: string;
      runningStages?: string[];
    };

function formatDuration(ms?: number): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = ((ms % 60_000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
}

function formatTokens(tokens?: TokenUsageSnapshot): string {
  if (!tokens?.total) return "";
  return `${tokens.total.toLocaleString()} tok`;
}

function truncateInline(value: string, maxChars = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function stageName(stage: StageTelemetry): string {
  return `${stage.stage}${stage.label ? ` (${stage.label})` : ""}`;
}

function stageSummary(stage: StageTelemetry): string {
  const suffix = [formatDuration(stage.durationMs), formatTokens(stage.tokens)].filter(Boolean).join(" · ");
  return `${stage.outcome === "completed" ? "✓" : "✗"} ${stageName(stage)} · ${stage.actor}${suffix ? ` · ${suffix}` : ""}`;
}

function aggregate(stages: StageTelemetry[]) {
  const tokens = stages.reduce<TokenUsageSnapshot>(
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
    durationMs: stages.reduce((sum, stage) => sum + stage.durationMs, 0),
    tokens,
  };
}

function colorForFinalStatus(status: FactoryRunState["finalStatus"], theme: any, text: string): string {
  if (status === "accepted") return theme.fg("success", text);
  if (status === "failed" || status === "blocked") return theme.fg("error", text);
  return theme.fg("warning", text);
}

function decisionSummary(record: Record<string, any>): string {
  const decision = record.decision ?? {};
  const label = record.label ? ` · ${record.label}` : "";
  const pass = typeof record.pass === "number"
    ? ` · pass ${record.pass}`
    : typeof record.repairPass === "number"
      ? ` · repair ${record.repairPass}`
      : "";
  const routed = decision.action ?? decision.disposition ?? decision.requirementClarity;
  const confidence = typeof decision.confidence === "number"
    ? ` · conf ${decision.confidence.toFixed(2)}`
    : typeof record.priorConfidence === "number"
      ? ` · conf ${record.priorConfidence.toFixed(2)}`
      : "";
  return `${record.stage ?? "decision"}${label}${pass}${routed ? ` → ${routed}` : ""}${confidence}`;
}

function appendRunHistory(lines: string[], state: FactoryRunState, theme: any): void {
  const checkpoints = state.checkpoints ?? [];
  const continuations = state.workerContinuations ?? [];
  const parallelBatches = state.parallelBatches ?? [];
  const decisions = state.decisions ?? [];

  if (checkpoints.length > 0 || continuations.length > 0 || parallelBatches.length > 0) {
    lines.push("", theme.bold(theme.fg("muted", "Recovery / concurrency history")));
    for (const checkpoint of checkpoints) {
      const name = `${checkpoint.stage}${checkpoint.label ? ` (${checkpoint.label})` : ""}`;
      lines.push(
        theme.fg(
          "dim",
          `checkpoint #${checkpoint.index} · ${name} · ${checkpoint.context.tokens.toLocaleString()} ctx`,
        ),
      );
    }
    for (const continuation of continuations) {
      lines.push(
        theme.fg(
          "dim",
          `continue #${continuation.pass} · ${continuation.phase} · ${continuation.label} · conf ${continuation.priorConfidence.toFixed(2)}`,
        ),
      );
    }
    for (const batch of parallelBatches) {
      lines.push(
        theme.fg("dim", `parallel batch #${batch.index} · ${batch.unitIds.join(", ")}`),
      );
    }
  }

  if (decisions.length > 0) {
    lines.push("", theme.bold(theme.fg("muted", "Decision history")));
    for (const decision of decisions) {
      lines.push(theme.fg("dim", decisionSummary(decision as Record<string, any>)));
    }
  }
}

function renderTranscriptEntry(data: TranscriptEntry, expanded: boolean, theme: any): string {
  if (data.kind === "run-start") {
    return [
      theme.bold(theme.fg("accent", `Software Factory v${data.version}`)),
      `${theme.fg("muted", "Objective:")} ${truncateInline(data.objective)}`,
    ].join("\n");
  }

  if (data.kind === "stage") {
    const stage = data.telemetry;
    const headline = stage.outcome === "completed"
      ? theme.fg("success", stageSummary(stage))
      : theme.fg("error", stageSummary(stage));

    if (!expanded) return headline;

    const details = [headline];
    if (stage.model) details.push(`${theme.fg("muted", "Model:")} ${stage.model}`);
    if (stage.tokens) {
      details.push(
        `${theme.fg("muted", "Tokens:")} ${stage.tokens.total.toLocaleString()} total ` +
          `(${stage.tokens.input.toLocaleString()} in / ${stage.tokens.output.toLocaleString()} out / ` +
          `${stage.tokens.cacheRead.toLocaleString()} cache read)`,
      );
    }
    if (stage.maxContextTokens) {
      const window = stage.contextWindow ? ` / ${stage.contextWindow.toLocaleString()}` : "";
      details.push(`${theme.fg("muted", "Max context:")} ${stage.maxContextTokens.toLocaleString()}${window} tok`);
    }
    if (stage.compactions) details.push(`${theme.fg("muted", "Pi compactions:")} ${stage.compactions}`);
    if (stage.error) details.push(theme.fg("error", `Error: ${stage.error}`));
    return details.join("\n");
  }

  if (data.kind === "context") {
    const name = `${data.stage}${data.label ? ` (${data.label})` : ""}`;
    const window = data.usage.contextWindow ? ` / ${data.usage.contextWindow.toLocaleString()}` : "";
    const percent = typeof data.usage.percent === "number" ? ` · ${data.usage.percent.toFixed(1)}%` : "";
    const prefix = data.level === "checkpoint" ? "△ checkpoint requested" : "△ context";
    const line = `${prefix} · ${name} · ${data.usage.tokens.toLocaleString()}${window} tok${percent}`;
    return data.level === "checkpoint" ? theme.fg("warning", line) : theme.fg("muted", line);
  }

  if (data.kind === "checkpoint-saved") {
    const name = `${data.stage}${data.label ? ` (${data.label})` : ""}`;
    const window = data.usage.contextWindow ? ` / ${data.usage.contextWindow.toLocaleString()}` : "";
    const percent = typeof data.usage.percent === "number" ? ` · ${data.usage.percent.toFixed(1)}%` : "";
    const line = `↻ checkpoint saved #${data.index} · ${name} · ${data.usage.tokens.toLocaleString()}${window} tok${percent}`;
    return theme.fg("warning", line);
  }

  if (data.kind === "run-error") {
    return [
      theme.bold(theme.fg("error", `Software Factory v${data.version} · ERROR`)),
      `${theme.fg("muted", "Objective:")} ${truncateInline(data.objective)}`,
      theme.fg("error", data.error),
    ].join("\n");
  }

  if (data.kind === "run-final") {
    const stages = data.state.telemetry ?? [];
    const totals = aggregate(stages);
    const status = (data.state.finalStatus ?? "stopped").toUpperCase();
    const lines = [
      theme.bold(colorForFinalStatus(data.state.finalStatus, theme, `Software Factory · ${status}`)),
      `${theme.fg("muted", "Run:")} ${data.state.id}`,
      `${theme.fg("muted", "Result:")} ${data.state.finalReason ?? data.state.phase}`,
      `${theme.fg("muted", "Stages:")} ${stages.length} · ${formatDuration(totals.durationMs)} · ${formatTokens(totals.tokens)}`,
    ];

    if (data.state.repairPasses > 0) {
      lines.push(`${theme.fg("muted", "Repairs:")} ${data.state.repairPasses}`);
    }
    if ((data.state.checkpoints?.length ?? 0) > 0) {
      lines.push(`${theme.fg("muted", "Context checkpoints:")} ${data.state.checkpoints!.length}`);
    }
    if ((data.state.workerContinuations?.length ?? 0) > 0) {
      lines.push(`${theme.fg("muted", "Worker continuations:")} ${data.state.workerContinuations!.length}`);
    }
    if ((data.state.parallelBatches?.length ?? 0) > 0) {
      lines.push(`${theme.fg("muted", "Parallel batches:")} ${data.state.parallelBatches!.length}`);
    }
    if ((data.state.decisions?.length ?? 0) > 0) {
      lines.push(`${theme.fg("muted", "Decisions:")} ${data.state.decisions!.length}`);
    }
    if (data.state.rescoutPasses > 0 || data.state.replanPasses > 0 || data.state.planGatePasses > 1) {
      lines.push(
        `${theme.fg("muted", "Planning recovery:")} rescout ${data.state.rescoutPasses} · replan ${data.state.replanPasses} · gates ${data.state.planGatePasses}`,
      );
    }
    if (expanded && stages.length > 0) {
      lines.push("", theme.fg("dim", stages.map(stageSummary).join("\n")));
      appendRunHistory(lines, data.state, theme);
    }
    return lines.join("\n");
  }

  const totals = aggregate(data.stages);
  const finalStatus = data.state?.finalStatus?.toUpperCase();
  const lines = [
    theme.bold(theme.fg("accent", `Software Factory v${data.version} · Status`)),
    `${theme.fg("muted", "Objective:")} ${truncateInline(data.objective)}`,
  ];

  if (data.state) {
    lines.push(`${theme.fg("muted", "Run:")} ${data.state.id}`);
    if (finalStatus) {
      lines.push(`${theme.fg("muted", "Final:")} ${colorForFinalStatus(data.state.finalStatus, theme, finalStatus)}`);
    }
    if (data.state.finalReason) lines.push(`${theme.fg("muted", "Reason:")} ${data.state.finalReason}`);
    if ((data.state.workerContinuations?.length ?? 0) > 0) {
      lines.push(`${theme.fg("muted", "Worker continuations:")} ${data.state.workerContinuations!.length}`);
    }
    if ((data.state.parallelBatches?.length ?? 0) > 0) {
      lines.push(`${theme.fg("muted", "Parallel batches:")} ${data.state.parallelBatches!.length}`);
    }
    if ((data.state.decisions?.length ?? 0) > 0) {
      lines.push(`${theme.fg("muted", "Decisions:")} ${data.state.decisions!.length}`);
    }
    lines.push(
      `${theme.fg("muted", "Planning:")} rescout ${data.state.rescoutPasses} · replan ${data.state.replanPasses} · gates ${data.state.planGatePasses}`,
    );
  } else {
    const runningStages = data.runningStages?.length
      ? data.runningStages
      : data.runningStage
        ? [data.runningStage]
        : [];
    if (runningStages.length > 0) {
      lines.push(`${theme.fg("muted", "Current:")} ${runningStages.join(" | ")}`);
    }
  }

  lines.push(`${theme.fg("muted", "Totals:")} ${data.stages.length} stages · ${formatDuration(totals.durationMs)} · ${formatTokens(totals.tokens)}`);

  if (data.stages.length > 0) {
    lines.push("", ...data.stages.map((stage) => {
      const line = stageSummary(stage);
      return stage.outcome === "completed" ? theme.fg("success", line) : theme.fg("error", line);
    }));
  }
  if (data.state) appendRunHistory(lines, data.state, theme);

  return lines.join("\n");
}

function findPersistedLastState(ctx: any): FactoryRunState | undefined {
  const entries = ctx.sessionManager?.getEntries?.() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as any;
    if (entry?.type !== "custom" || entry?.customType !== ENTRY_TYPE) continue;
    const data = entry.data as TranscriptEntry | undefined;
    if (data?.kind === "run-final") return data.state;
  }
  return undefined;
}

export default function softwareFactory(pi: ExtensionAPI) {
  let running = false;
  let lastState: FactoryRunState | undefined;
  let lastObjective: string | undefined;
  let progressEvents: FactoryProgressEvent[] = [];
  const activeStages = new Map<string, string>();

  pi.registerEntryRenderer(ENTRY_TYPE, (entry, options, theme) => {
    const data = entry.data as TranscriptEntry;
    return new Text(renderTranscriptEntry(data, options.expanded, theme));
  });

  pi.on("session_start", async (_event, ctx) => {
    // Clear a stale v0.2.0/v0.2.1 dock widget if this package is upgraded in-place.
    ctx.ui.setWidget("software-factory", undefined);
    lastState = findPersistedLastState(ctx);
    if (lastState) lastObjective = lastState.objective;
  });

  pi.registerCommand("factory", {
    description: "Run the Jev-routed Qwen/Astra software factory",
    handler: async (args, ctx) => {
      const objective = args.trim();
      if (!objective) {
        ctx.ui.notify("Usage: /factory <objective>", "warning");
        return;
      }
      if (running) {
        ctx.ui.notify("A software factory run is already active in this Pi session.", "warning");
        return;
      }

      // v0.2.2 no longer uses a dock widget. Clear any stale one left by an older build.
      ctx.ui.setWidget("software-factory", undefined);
      running = true;
      lastObjective = objective;
      lastState = undefined;
      progressEvents = [];
      activeStages.clear();
      const config = loadConfig(ctx.cwd);

      pi.appendEntry(ENTRY_TYPE, {
        kind: "run-start",
        version: VERSION,
        objective,
        startedAt: new Date().toISOString(),
      } satisfies TranscriptEntry);
      ctx.ui.setStatus("software-factory", "Factory · starting");

      try {
        const result = await runFactory(ctx.cwd, objective, config, (event) => {
          progressEvents.push(event);
          if (event.type === "started") {
            const label = event.label ? ` (${event.label})` : "";
            const name = `${event.stage}${label}`;
            activeStages.set(`${event.stage}\u0000${event.label ?? ""}`, name);
            ctx.ui.setStatus("software-factory", `Factory · ${name}`);
            return;
          }

          if (event.type === "context") {
            const label = event.label ? ` (${event.label})` : "";
            ctx.ui.setStatus(
              "software-factory",
              `Factory · ${event.stage}${label} · ${event.usage.tokens.toLocaleString()} ctx`,
            );
            pi.appendEntry(ENTRY_TYPE, {
              kind: "context",
              stage: event.stage,
              label: event.label,
              level: event.level,
              usage: event.usage,
            } satisfies TranscriptEntry);
            return;
          }

          if (event.type === "checkpoint-saved") {
            pi.appendEntry(ENTRY_TYPE, {
              kind: "checkpoint-saved",
              stage: event.stage,
              label: event.label,
              index: event.index,
              usage: event.usage,
            } satisfies TranscriptEntry);
            return;
          }

          activeStages.delete(
            `${event.telemetry.stage}\u0000${event.telemetry.label ?? ""}`,
          );
          pi.appendEntry(ENTRY_TYPE, {
            kind: "stage",
            telemetry: event.telemetry,
          } satisfies TranscriptEntry);
        });

        lastState = result;
        pi.appendEntry(ENTRY_TYPE, {
          kind: "run-final",
          version: VERSION,
          state: result,
        } satisfies TranscriptEntry);

        const level = result.finalStatus === "accepted" ? "info" : result.finalStatus === "failed" ? "error" : "warning";
        ctx.ui.notify(
          `Factory ${result.finalStatus ?? "stopped"}: ${result.finalReason ?? result.phase}\nRun: ${result.id}`,
          level,
        );
      } catch (error: any) {
        const message = error?.message ?? String(error);
        pi.appendEntry(ENTRY_TYPE, {
          kind: "run-error",
          version: VERSION,
          objective,
          error: message,
        } satisfies TranscriptEntry);
        ctx.ui.notify(`Factory failed: ${message}`, "error");
      } finally {
        running = false;
        activeStages.clear();
        ctx.ui.setStatus("software-factory", undefined);
      }
    },
  });

  pi.registerCommand("factory-status", {
    description: "Print the most recent software-factory run into the transcript",
    handler: async (_args, ctx) => {
      ctx.ui.setWidget("software-factory", undefined);

      if (!lastState) {
        lastState = findPersistedLastState(ctx);
        if (lastState) lastObjective = lastState.objective;
      }

      if (!lastObjective) {
        ctx.ui.notify("No software-factory run was found in this Pi session.", "warning");
        return;
      }

      const stages = lastState?.telemetry ?? progressEvents
        .filter((event): event is Extract<FactoryProgressEvent, { type: "completed" }> => event.type === "completed")
        .map((event) => event.telemetry);
      const lastStarted = [...progressEvents].reverse().find((event) => event.type === "started") as
        | Extract<FactoryProgressEvent, { type: "started" }>
        | undefined;

      pi.appendEntry(ENTRY_TYPE, {
        kind: "status",
        version: VERSION,
        objective: lastObjective,
        state: lastState,
        stages,
        runningStage: running && lastStarted
          ? `${lastStarted.stage}${lastStarted.label ? ` (${lastStarted.label})` : ""}`
          : undefined,
        runningStages: running ? [...activeStages.values()] : undefined,
      } satisfies TranscriptEntry);
    },
  });
}
