import type { StageTelemetry, TokenUsageSnapshot } from "./types.js";

/**
 * User-facing display labels for the fourteen semantic stage values the
 * controller emits.
 *
 * The table is keyed by semantic stage names only: there is deliberately no
 * model-branded alias mapping for legacy Qwen/Astra identifiers. Historical
 * runs that carry
 * legacy stage identifiers fall back to the raw identifier through
 * `stageDisplayName`; they are displayed as-is, never re-branded.
 */
export const STAGE_DISPLAY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  preflight: "Preflight",
  "baseline-verify": "Baseline verify",
  verify: "Verify",
  "parallel-snapshot": "Parallel snapshot",
  "parallel-integrate": "Parallel integrate",
  intake: "Intake",
  scout: "Scout",
  architect: "Architect",
  "plan-gate": "Plan gate",
  "worker-gate": "Worker gate",
  "review-gate": "Review gate",
  implementer: "Implementer",
  repairer: "Repairer",
  reviewer: "Reviewer",
});

/**
 * Readable display label for a stage. Unknown (e.g. historical) stage
 * identifiers fall back to the raw value.
 */
export function stageDisplayName(stage: string): string {
  return STAGE_DISPLAY_LABELS[stage] ?? stage;
}

export interface StageNameParts {
  /** Segment label, e.g. `implementation unit 1`, `rescout pass 1 · dependencies`. */
  label?: string;
  /** Actual model reference, displayed verbatim (no provider/model parsing). */
  model?: string;
}

/**
 * Format a stage name as `Role`, `Role [model]`, `Role (label)`, or
 * `Role [model] (label)`.
 *
 * The model string is displayed verbatim — never shortened, split on
 * provider/model separators, or reconstructed — so full references with
 * nested slashes survive unchanged. Absent model/label fields produce no
 * empty delimiters.
 */
export function formatStageName(stage: string, parts: StageNameParts = {}): string {
  let name = stageDisplayName(stage);
  if (parts.model) name += ` [${parts.model}]`;
  if (parts.label) name += ` (${parts.label})`;
  return name;
}

/**
 * Format a completed/failed stage summary:
 * `✓ Role [model] (label) · duration · tokens`.
 *
 * The existing outcome glyphs and duration/token formatting are preserved,
 * and the redundant actor suffix is omitted — the readable role already
 * identifies the actor. Absent duration/tokens produce no dangling `·`.
 */
export function formatStageSummary(stage: StageTelemetry): string {
  const glyph = stage.outcome === "completed" ? "✓" : "✗";
  const name = formatStageName(stage.stage, { label: stage.label, model: stage.model });
  const metrics = [formatDuration(stage.durationMs), formatTokens(stage.tokens)].filter(Boolean).join(" · ");
  return `${glyph} ${name}${metrics ? ` · ${metrics}` : ""}`;
}

/**
 * Pure duration formatting shared with the transcript UI: sub-second values
 * as `Nms`, sub-minute values as `N.Ns`, and longer values as `Nm N.Ns`.
 */
export function formatDuration(ms?: number): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = ((ms % 60_000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
}

/**
 * Pure token formatting: `N tok` with locale grouping. Empty when no total
 * is recorded.
 */
export function formatTokens(tokens?: TokenUsageSnapshot): string {
  if (!tokens?.total) return "";
  return `${tokens.total.toLocaleString()} tok`;
}
