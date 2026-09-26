import type { StageTelemetry } from "./types.js";

export function stageTimingMetrics(stages: StageTelemetry[]) {
  const intervals = stages
    .map((stage) => ({
      start: Date.parse(stage.startedAt),
      end: Date.parse(stage.endedAt),
      durationMs: stage.durationMs,
    }))
    .filter((interval) => Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end >= interval.start)
    .sort((a, b) => a.start - b.start);

  const totalStageDurationMs = stages.reduce((sum, stage) => sum + stage.durationMs, 0);
  if (intervals.length === 0) {
    return {
      totalStageDurationMs,
      stageSpanMs: 0,
      busyWallClockMs: 0,
      overlappingStageDurationMs: 0,
    };
  }

  let busyWallClockMs = 0;
  let currentStart = intervals[0].start;
  let currentEnd = intervals[0].end;

  for (const interval of intervals.slice(1)) {
    if (interval.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.end);
      continue;
    }

    busyWallClockMs += currentEnd - currentStart;
    currentStart = interval.start;
    currentEnd = interval.end;
  }
  busyWallClockMs += currentEnd - currentStart;

  return {
    totalStageDurationMs,
    stageSpanMs: intervals.at(-1)!.end - intervals[0].start,
    busyWallClockMs,
    overlappingStageDurationMs: Math.max(0, totalStageDurationMs - busyWallClockMs),
  };
}
