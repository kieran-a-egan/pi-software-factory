import { describe, expect, it } from "vitest";

import { stageTimingMetrics } from "../src/timing.js";
import type { StageTelemetry } from "../src/types.js";

const BASE = Date.UTC(2024, 0, 1, 0, 0, 0, 0);

function iso(msFromBase: number): string {
  return new Date(BASE + msFromBase).toISOString();
}

type StageOverrides = Partial<Omit<StageTelemetry, "stage" | "actor" | "startedAt" | "endedAt" | "durationMs" | "outcome">> & {
  stage?: string;
  actor?: StageTelemetry["actor"];
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  outcome?: StageTelemetry["outcome"];
};

function makeStage(overrides: StageOverrides = {}): StageTelemetry {
  return {
    stage: overrides.stage ?? "stage",
    actor: overrides.actor ?? "controller",
    startedAt: overrides.startedAt ?? iso(0),
    endedAt: overrides.endedAt ?? iso(0),
    durationMs: overrides.durationMs ?? 0,
    outcome: overrides.outcome ?? "completed",
  };
}

/** A valid stage whose parsed interval is [startMs, endMs] from the base instant. */
function interval(startMs: number, endMs: number, durationMs: number, stage: string): StageTelemetry {
  return makeStage({ stage, startedAt: iso(startMs), endedAt: iso(endMs), durationMs });
}

describe("stageTimingMetrics", () => {
  it("returns all-zero metrics for empty telemetry", () => {
    expect(stageTimingMetrics([])).toEqual({
      totalStageDurationMs: 0,
      stageSpanMs: 0,
      busyWallClockMs: 0,
      overlappingStageDurationMs: 0,
    });
  });

  it("returns the stage's own numbers for a single stage", () => {
    const stages = [interval(0, 10_000, 10_000, "only")];
    expect(stageTimingMetrics(stages)).toEqual({
      totalStageDurationMs: 10_000,
      stageSpanMs: 10_000,
      busyWallClockMs: 10_000,
      overlappingStageDurationMs: 0,
    });
  });

  it("unions disjoint stages with gaps without filling the gap", () => {
    const stages = [interval(0, 5_000, 5_000, "a"), interval(10_000, 20_000, 10_000, "b")];
    expect(stageTimingMetrics(stages)).toEqual({
      totalStageDurationMs: 15_000,
      stageSpanMs: 20_000,
      busyWallClockMs: 15_000,
      overlappingStageDurationMs: 0,
    });
  });

  it("treats touching intervals as one contiguous busy span", () => {
    const stages = [interval(0, 5_000, 5_000, "a"), interval(5_000, 10_000, 5_000, "b")];
    expect(stageTimingMetrics(stages)).toEqual({
      totalStageDurationMs: 10_000,
      stageSpanMs: 10_000,
      busyWallClockMs: 10_000,
      overlappingStageDurationMs: 0,
    });
  });

  it("counts the partial overlap once in busy time and as overlap", () => {
    const stages = [interval(0, 10_000, 10_000, "a"), interval(5_000, 15_000, 10_000, "b")];
    expect(stageTimingMetrics(stages)).toEqual({
      totalStageDurationMs: 20_000,
      stageSpanMs: 15_000,
      busyWallClockMs: 15_000,
      overlappingStageDurationMs: 5_000,
    });
  });

  it("characterizes nested intervals: stageSpanMs follows the last start-sorted interval's end, not the maximum end", () => {
    // After sorting by start, the outer interval [0, 10_000] comes first and the
    // nested interval [2_000, 3_000] is last, so the span ends at 3_000 even
    // though the union reaches 10_000.
    const stages = [interval(0, 10_000, 10_000, "outer"), interval(2_000, 3_000, 1_000, "inner")];
    expect(stageTimingMetrics(stages)).toEqual({
      totalStageDurationMs: 11_000,
      stageSpanMs: 3_000,
      busyWallClockMs: 10_000,
      overlappingStageDurationMs: 1_000,
    });
  });

  it("merges equal-start intervals and spans to the longer end", () => {
    const stages = [interval(0, 5_000, 5_000, "short"), interval(0, 10_000, 10_000, "long")];
    expect(stageTimingMetrics(stages)).toEqual({
      totalStageDurationMs: 15_000,
      stageSpanMs: 10_000,
      busyWallClockMs: 10_000,
      overlappingStageDurationMs: 5_000,
    });
  });

  it("is independent of input ordering for unsorted stages", () => {
    // Same fixture as the disjoint-with-gaps case, reversed.
    const stages = [interval(10_000, 20_000, 10_000, "b"), interval(0, 5_000, 5_000, "a")];
    expect(stageTimingMetrics(stages)).toEqual({
      totalStageDurationMs: 15_000,
      stageSpanMs: 20_000,
      busyWallClockMs: 15_000,
      overlappingStageDurationMs: 0,
    });
  });

  it("excludes a stage with an invalid timestamp but keeps its recorded duration in the total", () => {
    const stages = [
      interval(0, 5_000, 5_000, "valid"),
      makeStage({ stage: "invalid-end", startedAt: iso(10_000), endedAt: "not-a-date", durationMs: 3_000 }),
    ];
    expect(stageTimingMetrics(stages)).toEqual({
      totalStageDurationMs: 8_000,
      stageSpanMs: 5_000,
      busyWallClockMs: 5_000,
      overlappingStageDurationMs: 3_000,
    });
  });

  it("excludes reversed intervals from the union while keeping their recorded duration", () => {
    const stages = [
      interval(0, 5_000, 5_000, "valid"),
      makeStage({ stage: "reversed", startedAt: iso(10_000), endedAt: iso(0), durationMs: 2_000 }),
    ];
    expect(stageTimingMetrics(stages)).toEqual({
      totalStageDurationMs: 7_000,
      stageSpanMs: 5_000,
      busyWallClockMs: 5_000,
      overlappingStageDurationMs: 2_000,
    });
  });

  it("treats zero-length intervals as degenerate intervals in the union", () => {
    const stages = [interval(0, 0, 0, "point"), interval(1_000, 2_000, 1_000, "real")];
    expect(stageTimingMetrics(stages)).toEqual({
      totalStageDurationMs: 1_000,
      stageSpanMs: 2_000,
      busyWallClockMs: 1_000,
      overlappingStageDurationMs: 0,
    });
  });

  it("reports only the recorded duration sum when every interval is invalid", () => {
    const stages = [
      makeStage({ stage: "bad-start", startedAt: "nope", endedAt: iso(5_000), durationMs: 5_000 }),
      makeStage({ stage: "bad-end", startedAt: iso(0), endedAt: "also-nope", durationMs: 3_000 }),
    ];
    expect(stageTimingMetrics(stages)).toEqual({
      totalStageDurationMs: 8_000,
      stageSpanMs: 0,
      busyWallClockMs: 0,
      overlappingStageDurationMs: 0,
    });
  });

  it("clamps overlappingStageDurationMs to zero when recorded durations are below busy time", () => {
    const stages = [interval(0, 10_000, 2_000, "a"), interval(10_000, 20_000, 2_000, "b")];
    expect(stageTimingMetrics(stages)).toEqual({
      totalStageDurationMs: 4_000,
      stageSpanMs: 20_000,
      busyWallClockMs: 20_000,
      overlappingStageDurationMs: 0,
    });
  });

  it("does not mutate the input array or its stages", () => {
    const stages = [
      interval(5_000, 15_000, 10_000, "later"),
      interval(0, 10_000, 10_000, "earlier"),
      makeStage({ stage: "invalid", startedAt: "garbage", durationMs: 1_000 }),
    ];
    const before = structuredClone(stages);
    stageTimingMetrics(stages);
    expect(stages).toEqual(before);
    expect(stages.map((stage) => stage.stage)).toEqual(["later", "earlier", "invalid"]);
  });
});
