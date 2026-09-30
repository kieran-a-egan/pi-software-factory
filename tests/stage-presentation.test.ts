import { describe, expect, it } from "vitest";

import {
  STAGE_DISPLAY_LABELS,
  formatDuration,
  formatStageName,
  formatStageSummary,
  formatTokens,
  stageDisplayName,
} from "../src/stage-presentation.js";
import type { StageTelemetry } from "../src/types.js";

type StageOverrides = Partial<StageTelemetry>;

function makeStage(overrides: StageOverrides = {}): StageTelemetry {
  return {
    stage: "implementer",
    label: undefined,
    actor: "agent",
    model: undefined,
    startedAt: new Date(Date.UTC(2024, 0, 1)).toISOString(),
    endedAt: new Date(Date.UTC(2024, 0, 1, 0, 0, 1)).toISOString(),
    durationMs: 1_000,
    outcome: "completed",
    ...overrides,
  };
}

describe("STAGE_DISPLAY_LABELS", () => {
  it("covers exactly the fourteen semantic stage values", () => {
    expect(Object.keys(STAGE_DISPLAY_LABELS).sort()).toEqual(
      [
        "architect",
        "baseline-verify",
        "implementer",
        "intake",
        "parallel-integrate",
        "parallel-snapshot",
        "plan-gate",
        "preflight",
        "repairer",
        "review-gate",
        "reviewer",
        "scout",
        "verify",
        "worker-gate",
      ].sort(),
    );
  });

  it("maps each stage to its exact specified display label", () => {
    expect(STAGE_DISPLAY_LABELS).toEqual({
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
  });

  it("contains no qwen/astra alias keys or values", () => {
    for (const [stage, label] of Object.entries(STAGE_DISPLAY_LABELS)) {
      expect(stage.toLowerCase()).not.toContain("qwen");
      expect(stage.toLowerCase()).not.toContain("astra");
      expect(label.toLowerCase()).not.toContain("qwen");
      expect(label.toLowerCase()).not.toContain("astra");
    }
  });

  it("is frozen so consumers cannot mutate the shared contract", () => {
    expect(Object.isFrozen(STAGE_DISPLAY_LABELS)).toBe(true);
  });
});

describe("stageDisplayName", () => {
  it("returns the readable label for every semantic stage", () => {
    for (const [stage, label] of Object.entries(STAGE_DISPLAY_LABELS)) {
      expect(stageDisplayName(stage)).toBe(label);
    }
  });

  it("falls back to the raw identifier for unknown historical stages", () => {
    expect(stageDisplayName("qwen-scout")).toBe("qwen-scout");
    expect(stageDisplayName("astra-architect")).toBe("astra-architect");
    expect(stageDisplayName("qwen-implement")).toBe("qwen-implement");
    expect(stageDisplayName("unknown-stage")).toBe("unknown-stage");
  });
});

describe("formatStageName", () => {
  it("formats a plain stage as its readable label", () => {
    expect(formatStageName("scout")).toBe("Scout");
  });

  it("appends the verbatim model in brackets", () => {
    expect(formatStageName("scout", { model: "prov-scout/model-scout" })).toBe(
      "Scout [prov-scout/model-scout]",
    );
  });

  it("appends the label in parentheses", () => {
    expect(formatStageName("implementer", { label: "implementation unit 1" })).toBe(
      "Implementer (implementation unit 1)",
    );
  });

  it("orders model before label: Role [model] (label)", () => {
    expect(
      formatStageName("implementer", {
        model: "prov-im/model-im",
        label: "implementation unit 1",
      }),
    ).toBe("Implementer [prov-im/model-im] (implementation unit 1)");
  });

  it("produces no empty delimiters when model and label are absent", () => {
    const name = formatStageName("preflight");
    expect(name).toBe("Preflight");
    expect(name).not.toContain("[]");
    expect(name).not.toContain("()");
    expect(name).not.toContain(" ");
  });

  it("treats empty-string model and label as absent", () => {
    expect(formatStageName("scout", { model: "", label: "" })).toBe("Scout");
  });

  it("keeps label delimiters when only the model is absent", () => {
    expect(formatStageName("reviewer", { label: "after review repair 1" })).toBe(
      "Reviewer (after review repair 1)",
    );
  });

  it("keeps model delimiters when only the label is absent", () => {
    expect(formatStageName("reviewer", { model: "prov-rv/model-rv" })).toBe(
      "Reviewer [prov-rv/model-rv]",
    );
  });

  it("displays full provider/model references with multiple slashes verbatim", () => {
    const model = "provider/namespace/model-variant/extra";
    expect(formatStageName("scout", { model })).toBe(`Scout [${model}]`);
  });

  it("displays model names containing brand words verbatim", () => {
    const model = "prov-astra/qwen3-coder-480b-astra";
    expect(formatStageName("architect", { model })).toBe(`Architect [${model}]`);
  });

  it("displays bare Jev model references verbatim", () => {
    const model = "prov-jev/jev-model";
    expect(formatStageName("intake", { model })).toBe(`Intake [${model}]`);
  });

  it("does not shorten, split, or reconstruct the displayed model text", () => {
    const models = [
      "a/b",
      "a/b/c",
      "a/b/c/d/e",
      "prov/model-with-dashes",
      "prov/model.with.dots",
      "provider/model",
      "qwen/qwen-max",
    ];
    for (const model of models) {
      const name = formatStageName("scout", { model });
      expect(name).toBe(`Scout [${model}]`);
      expect(name).toContain(`[${model}]`);
    }
  });

  it("falls back to the raw identifier for unknown historical stages", () => {
    expect(formatStageName("qwen-scout", { model: "prov/model" })).toBe("qwen-scout [prov/model]");
    expect(formatStageName("astra-architect", { label: "pass 1" })).toBe("astra-architect (pass 1)");
  });
});

describe("formatStageSummary", () => {
  it("formats a completed stage with the check glyph, name, and metrics", () => {
    const stage = makeStage({
      stage: "implementer",
      label: "implementation unit 1",
      model: "prov-im/model-im",
      durationMs: 1_500,
      tokens: { input: 1_000, output: 235, cacheRead: 1_110, cacheWrite: 0, total: 1_235 },
    });
    expect(formatStageSummary(stage)).toBe("✓ Implementer [prov-im/model-im] (implementation unit 1) · 1.5s · 1,235 tok");
  });

  it("formats a failed stage with the cross glyph", () => {
    const stage = makeStage({ stage: "repairer", outcome: "failed", durationMs: 2_000 });
    expect(formatStageSummary(stage)).toBe("✗ Repairer · 2.0s");
  });

  it("omits the actor between name and metrics", () => {
    for (const actor of ["controller", "jev", "agent", "tools"] as const) {
      const stage = makeStage({ stage: "scout", actor, model: "prov-scout/model-scout", durationMs: 500 });
      const summary = formatStageSummary(stage);
      expect(summary).toBe("✓ Scout [prov-scout/model-scout] · 500ms");
      expect(summary.toLowerCase()).not.toContain(`· ${actor}`);
    }
  });

  it("omits absent duration and tokens without a dangling separator", () => {
    const stage = makeStage({ stage: "preflight", durationMs: undefined });
    expect(formatStageSummary(stage)).toBe("✓ Preflight");
  });

  it("keeps the duration when tokens are absent", () => {
    const stage = makeStage({ stage: "verify", durationMs: 65_000 });
    expect(formatStageSummary(stage)).toBe("✓ Verify · 1m 5.0s");
  });

  it("keeps the tokens when duration is absent", () => {
    const stage = makeStage({
      stage: "intake",
      model: "prov-jev/jev-model",
      durationMs: undefined,
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
    });
    expect(formatStageSummary(stage)).toBe("✓ Intake [prov-jev/jev-model] · 15 tok");
  });

  it("formats a stage with a zero duration using the pure duration helper behavior", () => {
    const stage = makeStage({ stage: "plan-gate", durationMs: 0 });
    expect(formatStageSummary(stage)).toBe("✓ Plan gate · 0ms");
  });

  it("displays the model verbatim inside the summary", () => {
    const model = "provider/namespace/model-variant/extra";
    const stage = makeStage({ stage: "architect", model });
    expect(formatStageSummary(stage)).toContain(`[${model}]`);
  });

  it("falls back to the raw identifier for unknown historical stages", () => {
    const stage = makeStage({ stage: "qwen-implement", outcome: "failed", durationMs: 3_000 });
    expect(formatStageSummary(stage)).toBe("✗ qwen-implement · 3.0s");
  });

  it("does not mutate the telemetry it formats", () => {
    const stage = makeStage({
      stage: "implementer",
      label: "implementation unit 1",
      model: "prov-im/model-im",
      durationMs: 1_500,
      tokens: { input: 1_000, output: 235, cacheRead: 1_110, cacheWrite: 0, total: 1_235 },
    });
    const before = structuredClone(stage);
    formatStageSummary(stage);
    expect(stage).toEqual(before);
  });
});

describe("formatDuration", () => {
  it("returns empty for undefined", () => {
    expect(formatDuration(undefined)).toBe("");
  });

  it("formats sub-second values as milliseconds", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("formats sub-minute values as seconds with one decimal", () => {
    expect(formatDuration(1_000)).toBe("1.0s");
    expect(formatDuration(1_500)).toBe("1.5s");
    expect(formatDuration(59_999)).toBe("60.0s");
  });

  it("formats minute-length values as minutes and seconds", () => {
    expect(formatDuration(60_000)).toBe("1m 0.0s");
    expect(formatDuration(65_000)).toBe("1m 5.0s");
    expect(formatDuration(125_000)).toBe("2m 5.0s");
  });
});

describe("formatTokens", () => {
  it("returns empty when no snapshot or total is recorded", () => {
    expect(formatTokens(undefined)).toBe("");
    expect(formatTokens({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 0 })).toBe("");
  });

  it("formats the total with locale grouping and the tok suffix", () => {
    expect(
      formatTokens({ input: 10_000, output: 2_345, cacheRead: 5, cacheWrite: 0, total: 12_345 }),
    ).toBe("12,345 tok");
    expect(
      formatTokens({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 }),
    ).toBe("1,000,000 tok");
  });
});
