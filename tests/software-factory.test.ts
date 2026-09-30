import { beforeEach, describe, expect, it, vi } from "vitest";

// Deterministic stand-ins for the Pi runtime: the TUI text component, config
// loading, and the controller are all mocked so the extension is exercised
// without real models, network access, or a live Pi session.
vi.mock("@earendil-works/pi-tui", () => ({
  Text: class Text {
    constructor(public text: string) {}
    render(): string[] {
      return this.text.split("\n");
    }
  },
}));

vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../src/controller.js", () => ({
  runFactory: vi.fn(),
}));

import softwareFactory from "../software-factory.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { loadConfig } from "../src/config.js";
import { runFactory } from "../src/controller.js";
import type {
  ContextUsageSnapshot,
  FactoryConfig,
  FactoryProgressEvent,
  FactoryRunState,
  StageTelemetry,
  TokenUsageSnapshot,
} from "../src/types.js";

const BASE = Date.UTC(2024, 0, 1, 0, 0, 0, 0);

function iso(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString();
}

function tokens(input: number, output: number, total: number): TokenUsageSnapshot {
  return { input, output, cacheRead: 0, cacheWrite: 0, total };
}

function makeStage(overrides: Partial<StageTelemetry> = {}): StageTelemetry {
  return {
    stage: "implementer",
    actor: "agent",
    startedAt: iso(0),
    endedAt: iso(1000),
    durationMs: 1000,
    outcome: "completed",
    ...overrides,
  };
}

function makeFinalState(overrides: Partial<FactoryRunState> = {}): FactoryRunState {
  return {
    id: "run-1",
    createdAt: iso(0),
    completedAt: iso(4000),
    cwd: "/test/repo",
    objective: "do the thing",
    phase: "completed",
    deterministicRepairPasses: 0,
    reviewRepairPasses: 0,
    repairPasses: 0,
    rescoutPasses: 0,
    replanPasses: 0,
    planGatePasses: 1,
    telemetry: [],
    finalStatus: "accepted",
    finalReason: "verified",
    ...overrides,
  };
}

function makeConfig(): FactoryConfig {
  return {
    models: {
      scout: { provider: "prov-s", model: "model-s", thinking: "low" },
      architect: { provider: "prov-a", model: "model-a", thinking: "low" },
      implementer: { provider: "prov-i", model: "model-i", thinking: "low" },
      reviewer: { provider: "prov-r", model: "model-r", thinking: "low" },
      repairer: { provider: "prov-p", model: "model-p", thinking: "low" },
    },
    jev: { model: "prov-jev/jev-model", minChoiceConfidence: 0.6, minNoulProbability: 0.65 },
    contextBudget: {
      enabled: true,
      warningTokens: 65_000,
      checkpointTokens: 75_000,
      hardLimitTokens: 88_000,
      maxCheckpointsPerStage: 3,
    },
    planningLoops: { maxRescoutPasses: 2, maxReplanPasses: 2 },
    parallelImplementation: { enabled: true, maxParallelUnits: 4 },
    runRoot: ".pi/runs",
    contextPaths: [],
    contextMaxBytes: 0,
    requireCleanWorkingTree: false,
    verificationCommands: [],
    maxDeterministicRepairPasses: 2,
    maxReviewRepairPasses: 2,
    maxWorkerContinuationPasses: 2,
    workerMaxRuntimeMinutes: 30,
    maxDiffCharsForReview: 100_000,
  };
}

const theme = {
  fg: (_color: string, text: string): string => text,
  bold: (text: string): string => text,
};

type SetStatusCall = { key: string; text: string | undefined };
type NotifyCall = { message: string; type?: string };

function createCtx(overrides: Record<string, unknown> = {}) {
  const calls = {
    setStatus: [] as SetStatusCall[],
    notify: [] as NotifyCall[],
    setWidget: [] as Array<{ key: string; content: unknown }>,
  };
  const ctx = {
    cwd: "/test/repo",
    mode: "print",
    hasUI: true,
    ui: {
      setWidget: (key: string, content: unknown) => void calls.setWidget.push({ key, content }),
      setStatus: (key: string, text: string | undefined) => void calls.setStatus.push({ key, text }),
      notify: (message: string, type?: string) => void calls.notify.push({ message, type }),
    },
    sessionManager: { getEntries: () => [] as unknown[] },
    ...overrides,
  };
  return { ctx, calls };
}

interface Harness {
  entries: Array<{ customType: string; data: any }>;
  commands: Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }>;
  renderers: Map<string, (entry: { data: any }, options: { expanded: boolean }, theme: any) => unknown>;
  handlers: Map<string, (event: unknown, ctx: any) => Promise<unknown> | unknown>;
  run: (args: string, ctx: any) => Promise<void>;
  status: (ctx: any) => Promise<void>;
  sessionStart: (ctx: any) => Promise<void>;
  render: (data: unknown, expanded?: boolean) => string;
  lastEntry: () => any;
}

function createHarness(): Harness {
  const harness: Harness = {
    entries: [],
    commands: new Map(),
    renderers: new Map(),
    handlers: new Map(),
    run: () => {
      throw new Error("harness not initialized");
    },
    status: () => {
      throw new Error("harness not initialized");
    },
    sessionStart: () => {
      throw new Error("harness not initialized");
    },
    render: () => {
      throw new Error("harness not initialized");
    },
    lastEntry: () => {
      throw new Error("harness not initialized");
    },
  };

  const pi = {
    on: (event: string, handler: (event: unknown, ctx: any) => Promise<unknown> | unknown) => {
      harness.handlers.set(event, handler);
      return () => void harness.handlers.delete(event);
    },
    registerEntryRenderer: (customType: string, renderer: Harness["renderers"] extends Map<string, infer R> ? R : never) => {
      harness.renderers.set(customType, renderer);
    },
    registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: any) => Promise<void> }) => {
      harness.commands.set(name, options);
    },
    appendEntry: (customType: string, data: any) => {
      harness.entries.push({ customType, data });
    },
  };

  softwareFactory(pi as unknown as ExtensionAPI);

  harness.run = (args: string, ctx: any) => harness.commands.get("factory")!.handler(args, ctx);
  harness.status = (ctx: any) => harness.commands.get("factory-status")!.handler("", ctx);
  harness.sessionStart = (ctx: any) => harness.handlers.get("session_start")!({}, ctx) as Promise<void>;
  harness.render = (data: unknown, expanded = false) => {
    const renderer = harness.renderers.get("software-factory")!;
    const component = renderer({ data }, { expanded }, theme);
    expect(component).toBeInstanceOf(Text);
    return (component as unknown as { text: string }).text;
  };
  harness.lastEntry = () => harness.entries[harness.entries.length - 1]?.data;
  return harness;
}

function scriptRun(events: FactoryProgressEvent[], result: FactoryRunState): void {
  vi.mocked(runFactory).mockImplementation(async (_cwd, _objective, _config, onProgress) => {
    for (const event of events) onProgress(event);
    return result;
  });
}

function contextUsage(overrides: Partial<ContextUsageSnapshot> = {}): ContextUsageSnapshot {
  return { tokens: 1000, ...overrides };
}

function completedStages(events: FactoryProgressEvent[]): StageTelemetry[] {
  return events
    .filter((event): event is Extract<FactoryProgressEvent, { type: "completed" }> => event.type === "completed")
    .map((event) => event.telemetry);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadConfig).mockImplementation(() => makeConfig());
});

describe("command registration", () => {
  it("uses model-neutral wording for the factory command description", () => {
    const harness = createHarness();
    const description = harness.commands.get("factory")!.description;
    expect(description).toBe("Run the Jev-routed software factory");
    expect(description).not.toMatch(/qwen|astra/i);
    expect(harness.commands.get("factory-status")!.description).toBe(
      "Print the most recent software-factory run into the transcript",
    );
  });
});

describe("/factory guards", () => {
  it("rejects an empty objective without starting a run", async () => {
    const harness = createHarness();
    const { ctx, calls } = createCtx();
    await harness.run("   ", ctx);
    expect(calls.notify).toEqual([{ message: "Usage: /factory <objective>", type: "warning" }]);
    expect(vi.mocked(runFactory)).not.toHaveBeenCalled();
    expect(harness.entries).toEqual([]);
  });

  it("rejects a second run while one is active", async () => {
    const harness = createHarness();
    let release!: (state: FactoryRunState) => void;
    const gate = new Promise<FactoryRunState>((resolve) => {
      release = resolve;
    });
    vi.mocked(runFactory).mockImplementation(async () => gate);

    const { ctx } = createCtx();
    const pending = harness.run("first run", ctx);
    const { ctx: ctx2, calls: calls2 } = createCtx();
    await harness.run("second run", ctx2);

    expect(calls2.notify).toEqual([
      { message: "A software factory run is already active in this Pi session.", type: "warning" },
    ]);
    expect(vi.mocked(runFactory)).toHaveBeenCalledTimes(1);

    release(makeFinalState());
    await pending;
  });
});

describe("/factory transcript and live status", () => {
  it("renders semantic headlines and live status for agent, Jev, and model-free stages", async () => {
    const harness = createHarness();
    const events: FactoryProgressEvent[] = [
      { type: "started", stage: "preflight", actor: "controller" },
      {
        type: "completed",
        telemetry: makeStage({ stage: "preflight", actor: "controller", startedAt: iso(0), endedAt: iso(300), durationMs: 300 }),
      },
      { type: "started", stage: "intake", actor: "jev", model: "prov-jev/jev-model" },
      {
        type: "completed",
        telemetry: makeStage({
          stage: "intake",
          actor: "jev",
          model: "prov-jev/jev-model",
          startedAt: iso(300),
          endedAt: iso(1100),
          durationMs: 800,
          tokens: tokens(100, 20, 120),
        }),
      },
      { type: "started", stage: "scout", actor: "agent", model: "prov-scout/model-scout" },
      {
        type: "completed",
        telemetry: makeStage({
          stage: "scout",
          actor: "agent",
          model: "prov-scout/model-scout",
          startedAt: iso(1100),
          endedAt: iso(2300),
          durationMs: 1200,
          tokens: tokens(200, 40, 240),
        }),
      },
      { type: "started", stage: "implementer", label: "implementation unit 1", actor: "agent", model: "prov-im/model-im" },
      {
        type: "context",
        stage: "implementer",
        label: "implementation unit 1",
        level: "warning",
        usage: contextUsage({ tokens: 12345, contextWindow: 200000, percent: 6.17 }),
      },
      {
        type: "checkpoint-saved",
        stage: "implementer",
        label: "implementation unit 1",
        index: 1,
        usage: contextUsage({ tokens: 13000, contextWindow: 200000, percent: 6.5 }),
      },
      {
        type: "completed",
        telemetry: makeStage({
          stage: "implementer",
          label: "implementation unit 1",
          actor: "agent",
          model: "prov-im/model-im",
          startedAt: iso(2300),
          endedAt: iso(3800),
          durationMs: 1500,
          tokens: tokens(1000, 235, 1235),
          maxContextTokens: 13000,
          contextWindow: 200000,
          compactions: 1,
        }),
      },
      { type: "started", stage: "reviewer", actor: "agent", model: "prov-rv/model-rv" },
      {
        type: "completed",
        telemetry: makeStage({
          stage: "reviewer",
          actor: "agent",
          model: "prov-rv/model-rv",
          startedAt: iso(3800),
          endedAt: iso(4700),
          durationMs: 900,
        }),
      },
    ];
    scriptRun(
      events,
      makeFinalState({
        objective: "do the thing",
        completedAt: iso(4700),
        telemetry: completedStages(events),
      }),
    );

    const { ctx, calls } = createCtx();
    await harness.run("do the thing", ctx);

    expect(calls.setStatus.map((call) => call.text)).toEqual([
      "Factory · starting",
      "Factory · Preflight",
      "Factory · Intake [prov-jev/jev-model]",
      "Factory · Scout [prov-scout/model-scout]",
      "Factory · Implementer [prov-im/model-im] (implementation unit 1)",
      "Factory · Implementer [prov-im/model-im] (implementation unit 1) · 12,345 ctx",
      "Factory · Reviewer [prov-rv/model-rv]",
      undefined,
    ]);

    const kinds = harness.entries.map((entry) => (entry.data as { kind: string }).kind);
    expect(kinds).toEqual([
      "run-start",
      "stage",
      "stage",
      "stage",
      "context",
      "checkpoint-saved",
      "stage",
      "stage",
      "run-final",
    ]);

    const stageEntries = harness.entries.filter((entry) => entry.data.kind === "stage");
    expect(harness.render(stageEntries[0].data)).toBe("✓ Preflight · 300ms");
    expect(harness.render(stageEntries[1].data)).toBe("✓ Intake [prov-jev/jev-model] · 800ms · 120 tok");
    expect(harness.render(stageEntries[2].data)).toBe("✓ Scout [prov-scout/model-scout] · 1.2s · 240 tok");
    expect(harness.render(stageEntries[3].data)).toBe(
      "✓ Implementer [prov-im/model-im] (implementation unit 1) · 1.5s · 1,235 tok",
    );
    expect(harness.render(stageEntries[4].data)).toBe("✓ Reviewer [prov-rv/model-rv] · 900ms");

    const implementerExpanded = harness.render(stageEntries[3].data, true);
    expect(implementerExpanded).toBe(
      [
        "✓ Implementer [prov-im/model-im] (implementation unit 1) · 1.5s · 1,235 tok",
        "Tokens: 1,235 total (1,000 in / 235 out / 0 cache read)",
        "Max context: 13,000 / 200,000 tok",
        "Pi compactions: 1",
      ].join("\n"),
    );
    expect(implementerExpanded).not.toContain("Model:");

    const contextEntry = harness.entries.find((entry) => entry.data.kind === "context")!;
    expect(harness.render(contextEntry.data)).toBe(
      "△ context · Implementer (implementation unit 1) · 12,345 / 200,000 tok · 6.2%",
    );

    const checkpointEntry = harness.entries.find((entry) => entry.data.kind === "checkpoint-saved")!;
    expect(harness.render(checkpointEntry.data)).toBe(
      "↻ checkpoint saved #1 · Implementer (implementation unit 1) · 13,000 / 200,000 tok · 6.5%",
    );

    const finalEntry = harness.entries.find((entry) => entry.data.kind === "run-final")!;
    expect(harness.render(finalEntry.data)).toBe(
      [
        "Software Factory · ACCEPTED",
        "Run: run-1",
        "Result: verified",
        "Stages: 5 · 4.7s wall · 1,595 tok",
      ].join("\n"),
    );

    expect(calls.notify).toEqual([
      { message: "Factory accepted: verified\nRun: run-1", type: "info" },
    ]);
    expect(calls.setStatus.at(-1)).toEqual({ key: "software-factory", text: undefined });
  });

  it("renders a failed stage headline with the cross glyph and error detail", async () => {
    const harness = createHarness();
    const failedStage = makeStage({
      stage: "repairer",
      label: "deterministic repair 1",
      actor: "agent",
      model: "prov-p/model-p",
      outcome: "failed",
      durationMs: 2000,
      error: "worker timed out",
    });
    scriptRun(
      [
        { type: "started", stage: "repairer", label: "deterministic repair 1", actor: "agent", model: "prov-p/model-p" },
        { type: "completed", telemetry: failedStage },
      ],
      makeFinalState({
        finalStatus: "failed",
        finalReason: "verification failed",
        telemetry: [failedStage],
      }),
    );

    const { ctx, calls } = createCtx();
    await harness.run("fix the thing", ctx);

    expect(calls.setStatus.map((call) => call.text)).toEqual([
      "Factory · starting",
      "Factory · Repairer [prov-p/model-p] (deterministic repair 1)",
      undefined,
    ]);
    expect(calls.notify).toEqual([
      { message: "Factory failed: verification failed\nRun: run-1", type: "error" },
    ]);

    const stageEntry = harness.entries.find((entry) => entry.data.kind === "stage")!;
    expect(harness.render(stageEntry.data)).toBe("✗ Repairer [prov-p/model-p] (deterministic repair 1) · 2.0s");
    expect(harness.render(stageEntry.data, true)).toBe(
      [
        "✗ Repairer [prov-p/model-p] (deterministic repair 1) · 2.0s",
        "Error: worker timed out",
      ].join("\n"),
    );
  });

  it("falls back gracefully for context events without a known model", async () => {
    const harness = createHarness();
    const events: FactoryProgressEvent[] = [
      { type: "started", stage: "verify", actor: "controller" },
      { type: "context", stage: "verify", level: "warning", usage: contextUsage({ tokens: 500 }) },
      { type: "started", stage: "repairer", label: "deterministic repair 1", actor: "agent" },
      {
        type: "context",
        stage: "repairer",
        label: "deterministic repair 1",
        level: "warning",
        usage: contextUsage({ tokens: 777 }),
      },
      { type: "context", stage: "intake", label: "mystery", level: "warning", usage: contextUsage({ tokens: 999 }) },
      {
        type: "completed",
        telemetry: makeStage({ stage: "verify", actor: "controller", startedAt: iso(0), endedAt: iso(500), durationMs: 500 }),
      },
      {
        type: "completed",
        telemetry: makeStage({
          stage: "repairer",
          label: "deterministic repair 1",
          actor: "agent",
          startedAt: iso(500),
          endedAt: iso(1500),
          durationMs: 1000,
        }),
      },
    ];
    scriptRun(events, makeFinalState({ telemetry: completedStages(events) }));

    const { ctx, calls } = createCtx();
    await harness.run("check it", ctx);

    expect(calls.setStatus.map((call) => call.text)).toEqual([
      "Factory · starting",
      "Factory · Verify",
      "Factory · Verify · 500 ctx",
      "Factory · Repairer (deterministic repair 1)",
      "Factory · Repairer (deterministic repair 1) · 777 ctx",
      "Factory · Intake (mystery) · 999 ctx",
      undefined,
    ]);
  });
});

describe("parallel active stages", () => {
  it("tracks concurrent implementer units with per-unit models and clears them on completion", async () => {
    const harness = createHarness();
    let release!: (state: FactoryRunState) => void;
    const gate = new Promise<FactoryRunState>((resolve) => {
      release = resolve;
    });
    let onProgress!: (event: FactoryProgressEvent) => void;
    vi.mocked(runFactory).mockImplementation(async (_cwd, _objective, _config, progress) => {
      onProgress = progress;
      return gate;
    });

    const unit1 = makeStage({
      stage: "implementer",
      label: "implementation unit 1",
      actor: "agent",
      model: "prov-im/model-im-1",
      startedAt: iso(0),
      endedAt: iso(2000),
      durationMs: 2000,
      tokens: tokens(500, 100, 600),
    });
    const unit2 = makeStage({
      stage: "implementer",
      label: "implementation unit 2",
      actor: "agent",
      model: "prov-im/model-im-2",
      startedAt: iso(1000),
      endedAt: iso(3000),
      durationMs: 2000,
      tokens: tokens(500, 100, 600),
    });
    const finalState = makeFinalState({
      objective: "build in parallel",
      completedAt: iso(3000),
      telemetry: [unit1, unit2],
    });

    const { ctx, calls } = createCtx();
    const pending = harness.run("build in parallel", ctx);

    onProgress({
      type: "started",
      stage: "implementer",
      label: "implementation unit 1",
      actor: "agent",
      model: "prov-im/model-im-1",
    });
    onProgress({
      type: "started",
      stage: "implementer",
      label: "implementation unit 2",
      actor: "agent",
      model: "prov-im/model-im-2",
    });

    const { ctx: ctx2 } = createCtx();
    await harness.status(ctx2);
    const both = harness.lastEntry();
    expect(both.state).toBeUndefined();
    expect(both.runningStage).toBe("Implementer [prov-im/model-im-2] (implementation unit 2)");
    expect(both.runningStages).toEqual([
      "Implementer [prov-im/model-im-1] (implementation unit 1)",
      "Implementer [prov-im/model-im-2] (implementation unit 2)",
    ]);
    expect(harness.render(both)).toContain(
      "Current: Implementer [prov-im/model-im-1] (implementation unit 1) | Implementer [prov-im/model-im-2] (implementation unit 2)",
    );

    onProgress({
      type: "context",
      stage: "implementer",
      label: "implementation unit 1",
      level: "warning",
      usage: contextUsage({ tokens: 11000 }),
    });
    onProgress({
      type: "context",
      stage: "implementer",
      label: "implementation unit 2",
      level: "warning",
      usage: contextUsage({ tokens: 22000 }),
    });

    onProgress({ type: "completed", telemetry: unit1 });

    const { ctx: ctx3 } = createCtx();
    await harness.status(ctx3);
    const one = harness.lastEntry();
    expect(one.runningStage).toBe("Implementer [prov-im/model-im-2] (implementation unit 2)");
    expect(one.runningStages).toEqual(["Implementer [prov-im/model-im-2] (implementation unit 2)"]);
    expect(one.stages).toEqual([unit1]);
    expect(harness.render(one)).toBe(
      [
        "Software Factory v0.9.0 · Status",
        "Objective: build in parallel",
        "Current: Implementer [prov-im/model-im-2] (implementation unit 2)",
        "Totals: 1 stages · 2.0s wall · 600 tok",
        "",
        "✓ Implementer [prov-im/model-im-1] (implementation unit 1) · 2.0s · 600 tok",
      ].join("\n"),
    );

    onProgress({ type: "completed", telemetry: unit2 });
    release(finalState);
    await pending;

    expect(calls.setStatus.map((call) => call.text)).toEqual([
      "Factory · starting",
      "Factory · Implementer [prov-im/model-im-1] (implementation unit 1)",
      "Factory · Implementer [prov-im/model-im-2] (implementation unit 2)",
      "Factory · Implementer [prov-im/model-im-1] (implementation unit 1) · 11,000 ctx",
      "Factory · Implementer [prov-im/model-im-2] (implementation unit 2) · 22,000 ctx",
      undefined,
    ]);
    expect(calls.notify).toEqual([
      { message: "Factory accepted: verified\nRun: run-1", type: "info" },
    ]);
    expect(harness.entries.map((entry) => (entry.data as { kind: string }).kind)).toEqual([
      "run-start",
      "status",
      "context",
      "context",
      "stage",
      "status",
      "stage",
      "run-final",
    ]);

    const { ctx: ctx4 } = createCtx();
    await harness.status(ctx4);
    const settled = harness.lastEntry();
    expect(settled.state).toBe(finalState);
    expect(settled.runningStage).toBeUndefined();
    expect(settled.runningStages).toBeUndefined();
    expect(harness.render(settled)).toBe(
      [
        "Software Factory v0.9.0 · Status",
        "Objective: build in parallel",
        "Run: run-1",
        "Final: ACCEPTED",
        "Reason: verified",
        "Planning: rescout 0 · replan 0 · gates 1",
        "Totals: 2 stages · 3.0s wall · 1,200 tok",
        "Concurrency: 1.0s overlapping stage work · 4.0s cumulative stage work",
        "",
        "✓ Implementer [prov-im/model-im-1] (implementation unit 1) · 2.0s · 600 tok",
        "✓ Implementer [prov-im/model-im-2] (implementation unit 2) · 2.0s · 600 tok",
      ].join("\n"),
    );
  });
});

describe("checkpoint resumption", () => {
  it("retains the resumed segment's model across checkpoint teardown and resumption", async () => {
    const harness = createHarness();
    let release!: (state: FactoryRunState) => void;
    const gate = new Promise<FactoryRunState>((resolve) => {
      release = resolve;
    });
    let onProgress!: (event: FactoryProgressEvent) => void;
    vi.mocked(runFactory).mockImplementation(async (_cwd, _objective, _config, progress) => {
      onProgress = progress;
      return gate;
    });

    const initialSegment = makeStage({
      stage: "implementer",
      label: "implementation unit 1",
      actor: "agent",
      model: "prov-im/model-im-1",
      startedAt: iso(0),
      endedAt: iso(2000),
      durationMs: 2000,
      tokens: tokens(500, 100, 600),
    });
    const unit2 = makeStage({
      stage: "implementer",
      label: "implementation unit 2",
      actor: "agent",
      model: "prov-im/model-im-2",
      startedAt: iso(1000),
      endedAt: iso(4000),
      durationMs: 3000,
      tokens: tokens(700, 140, 840),
    });
    // A distinct model on the resumed segment proves the status looks the
    // model up from the resumed started event, not from the torn-down
    // initial segment.
    const resumedSegment = makeStage({
      stage: "implementer",
      label: "implementation unit 1 · resume 1",
      actor: "agent",
      model: "prov-im/model-im-1r",
      startedAt: iso(2500),
      endedAt: iso(4500),
      durationMs: 2000,
      tokens: tokens(400, 80, 480),
    });
    const finalState = makeFinalState({
      objective: "resume after checkpoint",
      completedAt: iso(5000),
      telemetry: [initialSegment, resumedSegment, unit2],
    });

    const { ctx, calls } = createCtx();
    const pending = harness.run("resume after checkpoint", ctx);

    // Controller event order: the initial segment completes before the
    // checkpoint is saved, the checkpoint-saved event carries the base
    // label, and the resumed segment starts with a `· resume N` label.
    onProgress({
      type: "started",
      stage: "implementer",
      label: "implementation unit 1",
      actor: "agent",
      model: "prov-im/model-im-1",
    });
    onProgress({
      type: "started",
      stage: "implementer",
      label: "implementation unit 2",
      actor: "agent",
      model: "prov-im/model-im-2",
    });
    onProgress({
      type: "context",
      stage: "implementer",
      label: "implementation unit 1",
      level: "warning",
      usage: contextUsage({ tokens: 11000 }),
    });
    onProgress({ type: "completed", telemetry: initialSegment });
    onProgress({
      type: "checkpoint-saved",
      stage: "implementer",
      label: "implementation unit 1",
      index: 1,
      usage: contextUsage({ tokens: 13000, contextWindow: 200000, percent: 6.5 }),
    });
    onProgress({
      type: "started",
      stage: "implementer",
      label: "implementation unit 1 · resume 1",
      actor: "agent",
      model: "prov-im/model-im-1r",
    });
    onProgress({
      type: "context",
      stage: "implementer",
      label: "implementation unit 1 · resume 1",
      level: "warning",
      usage: contextUsage({ tokens: 21000 }),
    });

    const { ctx: ctx2 } = createCtx();
    await harness.status(ctx2);
    const active = harness.lastEntry();
    expect(active.state).toBeUndefined();
    expect(active.runningStage).toBe("Implementer [prov-im/model-im-1r] (implementation unit 1 · resume 1)");
    expect(active.runningStages).toEqual([
      "Implementer [prov-im/model-im-2] (implementation unit 2)",
      "Implementer [prov-im/model-im-1r] (implementation unit 1 · resume 1)",
    ]);
    expect(harness.render(active)).toBe(
      [
        "Software Factory v0.9.0 · Status",
        "Objective: resume after checkpoint",
        "Current: Implementer [prov-im/model-im-2] (implementation unit 2) | Implementer [prov-im/model-im-1r] (implementation unit 1 · resume 1)",
        "Totals: 1 stages · 2.0s wall · 600 tok",
        "",
        "✓ Implementer [prov-im/model-im-1] (implementation unit 1) · 2.0s · 600 tok",
      ].join("\n"),
    );

    // Completing the resumed segment removes only its identity; the
    // concurrent unit keeps its own model metadata.
    onProgress({ type: "completed", telemetry: resumedSegment });

    const { ctx: ctx3 } = createCtx();
    await harness.status(ctx3);
    const one = harness.lastEntry();
    expect(one.runningStages).toEqual(["Implementer [prov-im/model-im-2] (implementation unit 2)"]);
    expect(one.stages).toEqual([initialSegment, resumedSegment]);
    expect(harness.render(one)).toBe(
      [
        "Software Factory v0.9.0 · Status",
        "Objective: resume after checkpoint",
        "Current: Implementer [prov-im/model-im-2] (implementation unit 2)",
        "Totals: 2 stages · 4.5s wall · 1,080 tok",
        "",
        "✓ Implementer [prov-im/model-im-1] (implementation unit 1) · 2.0s · 600 tok",
        "✓ Implementer [prov-im/model-im-1r] (implementation unit 1 · resume 1) · 2.0s · 480 tok",
      ].join("\n"),
    );

    onProgress({ type: "completed", telemetry: unit2 });
    release(finalState);
    await pending;

    expect(calls.setStatus.map((call) => call.text)).toEqual([
      "Factory · starting",
      "Factory · Implementer [prov-im/model-im-1] (implementation unit 1)",
      "Factory · Implementer [prov-im/model-im-2] (implementation unit 2)",
      "Factory · Implementer [prov-im/model-im-1] (implementation unit 1) · 11,000 ctx",
      "Factory · Implementer [prov-im/model-im-1r] (implementation unit 1 · resume 1)",
      "Factory · Implementer [prov-im/model-im-1r] (implementation unit 1 · resume 1) · 21,000 ctx",
      undefined,
    ]);
    expect(calls.notify).toEqual([
      { message: "Factory accepted: verified\nRun: run-1", type: "info" },
    ]);
    expect(calls.setStatus.at(-1)).toEqual({ key: "software-factory", text: undefined });
    expect(harness.entries.map((entry) => (entry.data as { kind: string }).kind)).toEqual([
      "run-start",
      "context",
      "stage",
      "checkpoint-saved",
      "context",
      "status",
      "stage",
      "status",
      "stage",
      "run-final",
    ]);

    const stageEntries = harness.entries.filter((entry) => entry.data.kind === "stage");
    expect(harness.render(stageEntries[0].data)).toBe("✓ Implementer [prov-im/model-im-1] (implementation unit 1) · 2.0s · 600 tok");
    expect(harness.render(stageEntries[1].data)).toBe("✓ Implementer [prov-im/model-im-1r] (implementation unit 1 · resume 1) · 2.0s · 480 tok");
    expect(harness.render(stageEntries[2].data)).toBe("✓ Implementer [prov-im/model-im-2] (implementation unit 2) · 3.0s · 840 tok");

    const checkpointEntry = harness.entries.find((entry) => entry.data.kind === "checkpoint-saved")!;
    expect(harness.render(checkpointEntry.data)).toBe(
      "↻ checkpoint saved #1 · Implementer (implementation unit 1) · 13,000 / 200,000 tok · 6.5%",
    );

    const { ctx: ctx4 } = createCtx();
    await harness.status(ctx4);
    const settled = harness.lastEntry();
    expect(settled.state).toBe(finalState);
    expect(settled.runningStage).toBeUndefined();
    expect(settled.runningStages).toBeUndefined();
    expect(harness.render(settled)).toBe(
      [
        "Software Factory v0.9.0 · Status",
        "Objective: resume after checkpoint",
        "Run: run-1",
        "Final: ACCEPTED",
        "Reason: verified",
        "Planning: rescout 0 · replan 0 · gates 1",
        "Totals: 3 stages · 5.0s wall · 1,920 tok",
        "Concurrency: 2.5s overlapping stage work · 7.0s cumulative stage work",
        "",
        "✓ Implementer [prov-im/model-im-1] (implementation unit 1) · 2.0s · 600 tok",
        "✓ Implementer [prov-im/model-im-1r] (implementation unit 1 · resume 1) · 2.0s · 480 tok",
        "✓ Implementer [prov-im/model-im-2] (implementation unit 2) · 3.0s · 840 tok",
      ].join("\n"),
    );
  });
});

describe("aggregate presentation", () => {
  it("presents disjoint stages without a concurrency line", async () => {
    const harness = createHarness();
    const verify = makeStage({
      stage: "verify",
      actor: "controller",
      startedAt: iso(0),
      endedAt: iso(1000),
      durationMs: 1000,
      tokens: tokens(75, 25, 100),
    });
    const baseline = makeStage({
      stage: "baseline-verify",
      actor: "controller",
      startedAt: iso(2000),
      endedAt: iso(4000),
      durationMs: 2000,
      tokens: tokens(150, 150, 300),
    });
    const finalState = makeFinalState({
      objective: "disjoint aggregate",
      completedAt: iso(4000),
      telemetry: [verify, baseline],
    });
    scriptRun(
      [
        { type: "started", stage: "verify", actor: "controller" },
        { type: "completed", telemetry: verify },
        { type: "started", stage: "baseline-verify", actor: "controller" },
        { type: "completed", telemetry: baseline },
      ],
      finalState,
    );

    const { ctx } = createCtx();
    await harness.run("disjoint aggregate", ctx);

    const finalEntry = harness.entries.find((entry) => entry.data.kind === "run-final")!;
    expect(harness.render(finalEntry.data)).toBe(
      [
        "Software Factory · ACCEPTED",
        "Run: run-1",
        "Result: verified",
        "Stages: 2 · 4.0s wall · 400 tok",
      ].join("\n"),
    );

    await harness.status(ctx);
    const statusEntry = harness.lastEntry();
    expect(harness.render(statusEntry)).toBe(
      [
        "Software Factory v0.9.0 · Status",
        "Objective: disjoint aggregate",
        "Run: run-1",
        "Final: ACCEPTED",
        "Reason: verified",
        "Planning: rescout 0 · replan 0 · gates 1",
        "Totals: 2 stages · 4.0s wall · 400 tok",
        "",
        "✓ Verify · 1.0s · 100 tok",
        "✓ Baseline verify · 2.0s · 300 tok",
      ].join("\n"),
    );
  });

  it("presents overlapping stages with the concurrency line", async () => {
    const harness = createHarness();
    const verify = makeStage({
      stage: "verify",
      actor: "controller",
      startedAt: iso(0),
      endedAt: iso(2000),
      durationMs: 2000,
      tokens: tokens(100, 100, 200),
    });
    const baseline = makeStage({
      stage: "baseline-verify",
      actor: "controller",
      startedAt: iso(1000),
      endedAt: iso(3000),
      durationMs: 2000,
      tokens: tokens(100, 100, 200),
    });
    const finalState = makeFinalState({
      objective: "overlapping aggregate",
      completedAt: iso(3000),
      telemetry: [verify, baseline],
    });
    scriptRun(
      [
        { type: "started", stage: "verify", actor: "controller" },
        { type: "completed", telemetry: verify },
        { type: "started", stage: "baseline-verify", actor: "controller" },
        { type: "completed", telemetry: baseline },
      ],
      finalState,
    );

    const { ctx } = createCtx();
    await harness.run("overlapping aggregate", ctx);

    const finalEntry = harness.entries.find((entry) => entry.data.kind === "run-final")!;
    expect(harness.render(finalEntry.data)).toBe(
      [
        "Software Factory · ACCEPTED",
        "Run: run-1",
        "Result: verified",
        "Stages: 2 · 3.0s wall · 400 tok",
        "Concurrency: 1.0s overlapping stage work · 4.0s cumulative stage work",
      ].join("\n"),
    );

    await harness.status(ctx);
    const statusEntry = harness.lastEntry();
    expect(harness.render(statusEntry)).toBe(
      [
        "Software Factory v0.9.0 · Status",
        "Objective: overlapping aggregate",
        "Run: run-1",
        "Final: ACCEPTED",
        "Reason: verified",
        "Planning: rescout 0 · replan 0 · gates 1",
        "Totals: 2 stages · 3.0s wall · 400 tok",
        "Concurrency: 1.0s overlapping stage work · 4.0s cumulative stage work",
        "",
        "✓ Verify · 2.0s · 200 tok",
        "✓ Baseline verify · 2.0s · 200 tok",
      ].join("\n"),
    );
  });
});

describe("session persistence", () => {
  it("restores the persisted run for factory-status after session_start", async () => {
    const harness = createHarness();
    const persistedState = makeFinalState({
      id: "run-persisted",
      objective: "persisted objective",
      completedAt: iso(5000),
      telemetry: [
        makeStage({
          stage: "scout",
          actor: "agent",
          model: "prov-s/model-s",
          startedAt: iso(0),
          endedAt: iso(2000),
          durationMs: 2000,
          tokens: tokens(60, 40, 100),
        }),
        makeStage({
          stage: "implementer",
          label: "implementation unit 1",
          actor: "agent",
          model: "prov-i/model-i",
          startedAt: iso(2000),
          endedAt: iso(5000),
          durationMs: 3000,
          tokens: tokens(150, 150, 300),
        }),
      ],
    });
    const { ctx, calls } = createCtx({
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "software-factory",
            data: { kind: "run-final", version: "0.9.0", state: persistedState },
          },
        ],
      },
    });

    await harness.sessionStart(ctx);
    expect(calls.setWidget).toContainEqual({ key: "software-factory", content: undefined });

    await harness.status(ctx);
    const statusEntry = harness.lastEntry();
    expect(statusEntry.state).toBe(persistedState);
    expect(statusEntry.objective).toBe("persisted objective");
    expect(statusEntry.runningStage).toBeUndefined();
    expect(statusEntry.runningStages).toBeUndefined();
    expect(statusEntry.stages).toEqual(persistedState.telemetry);
    expect(harness.render(statusEntry)).toBe(
      [
        "Software Factory v0.9.0 · Status",
        "Objective: persisted objective",
        "Run: run-persisted",
        "Final: ACCEPTED",
        "Reason: verified",
        "Planning: rescout 0 · replan 0 · gates 1",
        "Totals: 2 stages · 5.0s wall · 400 tok",
        "",
        "✓ Scout [prov-s/model-s] · 2.0s · 100 tok",
        "✓ Implementer [prov-i/model-i] (implementation unit 1) · 3.0s · 300 tok",
      ].join("\n"),
    );
  });

  it("notifies when no run is available", async () => {
    const harness = createHarness();
    const { ctx, calls } = createCtx();
    await harness.status(ctx);
    expect(calls.notify).toEqual([
      { message: "No software-factory run was found in this Pi session.", type: "warning" },
    ]);
    expect(harness.entries).toEqual([]);
  });
});
