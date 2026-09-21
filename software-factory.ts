import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./src/config.js";
import { runFactory } from "./src/controller.js";
import type { FactoryProgressEvent, FactoryRunState, StageTelemetry } from "./src/types.js";

const VERSION = "0.2.0";

function formatDuration(ms?: number): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(stage: StageTelemetry): string {
  const total = stage.tokens?.total;
  if (!total) return "";
  return `${total.toLocaleString()} tok`;
}

function renderWidget(
  objective: string,
  events: FactoryProgressEvent[],
  final?: FactoryRunState,
): string[] {
  const completed = events
    .filter((event): event is Extract<FactoryProgressEvent, { type: "completed" }> => event.type === "completed")
    .slice(-8);
  const lastEvent = events.at(-1);
  const current = lastEvent?.type === "started" ? lastEvent : undefined;

  const lines = [
    `Software Factory v${VERSION}`,
    `Objective: ${objective}`,
  ];

  for (const event of completed) {
    const telemetry = event.telemetry;
    const suffix = [formatDuration(telemetry.durationMs), formatTokens(telemetry)].filter(Boolean).join(" · ");
    lines.push(`${telemetry.outcome === "completed" ? "✓" : "✗"} ${telemetry.stage}${telemetry.label ? ` (${telemetry.label})` : ""} · ${telemetry.actor}${suffix ? ` · ${suffix}` : ""}`);
  }

  if (!final && current?.type === "started") {
    lines.push(`→ ${current.stage}${current.label ? ` (${current.label})` : ""}`);
  }

  if (final?.finalStatus) {
    lines.push(`${final.finalStatus === "accepted" ? "✓" : "!"} ${final.finalStatus.toUpperCase()} · ${final.id}`);
  }

  return lines;
}

export default function softwareFactory(pi: ExtensionAPI) {
  let running = false;
  let lastState: FactoryRunState | undefined;
  let lastObjective: string | undefined;
  let progressEvents: FactoryProgressEvent[] = [];

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

      running = true;
      lastObjective = objective;
      lastState = undefined;
      progressEvents = [];
      const config = loadConfig(ctx.cwd);
      ctx.ui.setStatus("software-factory", "Factory: starting");
      ctx.ui.setWidget("software-factory", renderWidget(objective, progressEvents));

      try {
        const result = await runFactory(ctx.cwd, objective, config, (event) => {
          progressEvents.push(event);
          if (event.type === "started") {
            ctx.ui.setStatus("software-factory", `Factory: ${event.stage}`);
          }
          ctx.ui.setWidget("software-factory", renderWidget(objective, progressEvents));
        });

        lastState = result;
        ctx.ui.setWidget("software-factory", renderWidget(objective, progressEvents, result));
        const level = result.finalStatus === "accepted" ? "info" : result.finalStatus === "failed" ? "error" : "warning";
        ctx.ui.notify(
          `Factory ${result.finalStatus ?? "stopped"}: ${result.finalReason ?? result.phase}\nRun: ${result.id}`,
          level,
        );
      } catch (error: any) {
        ctx.ui.notify(`Factory failed: ${error?.message ?? String(error)}`, "error");
      } finally {
        running = false;
        ctx.ui.setStatus("software-factory", undefined);
      }
    },
  });

  pi.registerCommand("factory-status", {
    description: "Show the most recent software-factory run in this Pi session",
    handler: async (_args, ctx) => {
      if (!lastObjective) {
        ctx.ui.notify("No software-factory run has been started in this Pi session.", "warning");
        return;
      }
      ctx.ui.setWidget("software-factory", renderWidget(lastObjective, progressEvents, lastState));
      if (lastState) {
        ctx.ui.notify(
          `Factory ${lastState.finalStatus ?? "stopped"}: ${lastState.finalReason ?? lastState.phase}\nRun: ${lastState.id}`,
          lastState.finalStatus === "accepted" ? "info" : "warning",
        );
      }
    },
  });
}
