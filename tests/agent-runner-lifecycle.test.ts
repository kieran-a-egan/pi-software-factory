/**
 * Deterministic lifecycle coverage for src/agent-runner.ts: the overall
 * maxRuntimeMs deadline must span both the initial turn and submission
 * recovery, and external AbortController cancellation must terminate
 * cooperative (scripted) sessions exactly once, without waiting for any
 * deadline.
 *
 * All time is virtual: fake Date/setTimeout/clearTimeout with a fixed
 * nonzero epoch. No real sleeps, polling, models, network, or Git.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  readOnlyTools,
  runCheckpointableAgent,
  type RunCheckpointableAgentOptions,
} from "../src/agent-runner.js";
import type { ModelRef, WorkerCheckpoint, WorkerReport } from "../src/types.js";
import {
  createModelHarness,
  makeDisabledContextBudget,
  makeWorkerReportFixture,
  type AgentRunnerHarness,
} from "./helpers/agent-runner-harness.js";

/** Fixed nonzero epoch; the deadline anchor (Date.now() at run start). */
const EPOCH = 1_700_000_000_000;
const MAX_RUNTIME_MS = 60_000;
const TIMEOUT_MESSAGE = "implementer exceeded max runtime of 1 minute(s)";
const ABORT_MESSAGE = "implementer aborted by controller";

/** Deterministic microtask drain (queueMicrotask is not faked by Vitest). */
async function flushMicrotasks(rounds = 32): Promise<void> {
  let step = Promise.resolve();
  for (let i = 0; i < rounds; i += 1) step = step.then(() => undefined);
  await step;
}

/**
 * Common checkpointable-run options for these lifecycle scenarios. The
 * context budget is disabled so checkpoint machinery cannot interfere with
 * deadline/cancellation behavior.
 */
function lifecycleOptions(
  harness: AgentRunnerHarness,
  modelRef: ModelRef,
  modelRuntime: ModelRuntime,
): Omit<RunCheckpointableAgentOptions<WorkerReport>, "maxRuntimeMs" | "abortSignal"> {
  return {
    role: "implementer",
    cwd: process.cwd(),
    model: modelRef,
    systemPrompt: "You are a scripted test implementer.",
    prompt: "Do the initial scripted work",
    modelRuntime,
    tools: readOnlyTools(),
    validate: (value: unknown) => value as WorkerReport,
    sessionFactory: harness.sessionFactory,
    contextBudget: makeDisabledContextBudget(),
    validateCheckpoint: (value: unknown) => value as WorkerCheckpoint,
  };
}

describe("agent runner lifecycle: shared deadline and external abort", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);
  });

  afterEach(() => {
    // Restore even when a scenario fails so no fake clock or spy leaks.
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("applies the overall deadline across initial work and recovery, not per-prompt", async () => {
    const { harness, model, modelRef, modelRuntime } = createModelHarness();
    const runPromise = runCheckpointableAgent<WorkerReport>({
      ...lifecycleOptions(harness, modelRef, modelRuntime),
      maxRuntimeMs: MAX_RUNTIME_MS,
    });
    let caught: unknown;
    runPromise.catch((error: unknown) => {
      caught = error;
    });

    // t = 0: initial turn entered.
    await harness.session.promptEntered(1);
    vi.advanceTimersByTime(40_000); // t = 40_000: initial work done, no submission
    harness.session.resolveTurn(1);

    // t = 40_000: recovery opens within the same 60s budget and is held open.
    await harness.session.promptEntered(2);
    expect(harness.session.prompts[1]).toContain("FACTORY STRUCTURED SUBMISSION REQUIRED");

    // t = 59_999: the run is still pending, one virtual ms before the shared deadline.
    vi.advanceTimersByTime(19_999);
    await flushMicrotasks();
    expect(caught).toBeUndefined();

    // t = 60_000: the shared deadline fires — 20s after recovery started, not 60s.
    vi.advanceTimersByTime(1);
    await flushMicrotasks();

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(TIMEOUT_MESSAGE);

    // One factory invocation, exactly two prompts, deadline-triggered abort,
    // exactly-once cleanup, and no runner timer left behind after timeout.
    expect(harness.requests).toHaveLength(1);
    expect(harness.session.prompts).toHaveLength(2);
    expect(harness.session.abortCalls).toHaveLength(1);
    expect(harness.session.unsubscribeCalls).toBe(1);
    expect(harness.session.disposeCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    // Settle the abandoned scripted turn so no scripted work is left pending.
    harness.session.resolveTurn(2);
  });

  it("completes a recovery inside the budget and leaves no leaked deadline timer", async () => {
    const { harness, model, modelRef, modelRuntime } = createModelHarness();
    const runPromise = runCheckpointableAgent<WorkerReport>({
      ...lifecycleOptions(harness, modelRef, modelRuntime),
      maxRuntimeMs: MAX_RUNTIME_MS,
    });

    // t = 40_000: initial turn finishes without submission.
    await harness.session.promptEntered(1);
    vi.advanceTimersByTime(40_000);
    harness.session.resolveTurn(1);

    // t = 40_000..55_000: recovery submits successfully, well within the budget.
    await harness.session.promptEntered(2);
    await harness.session.submitResult(makeWorkerReportFixture());
    vi.advanceTimersByTime(15_000);
    harness.session.resolveTurn(2);

    const outcome = await runPromise;
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") throw new Error("unreachable: expected result outcome");
    expect(outcome.result).toEqual(makeWorkerReportFixture());

    // The deadline timer must be cleared on success; a leaked timer would
    // later call session.abort() on an already completed run.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000); // well past the original budget
    expect(harness.session.abortCalls).toHaveLength(0);

    expect(harness.requests).toHaveLength(1);
    expect(harness.session.prompts).toHaveLength(2);
    expect(harness.session.unsubscribeCalls).toBe(1);
    expect(harness.session.disposeCalls).toBe(1);
  });

  it.each([
    { label: "during the initial turn", abortOnTurn: 1, finalPromptCount: 1 },
    { label: "during submission recovery", abortOnTurn: 2, finalPromptCount: 2 },
  ])(
    "terminates the run when the controller aborts $label",
    async ({ abortOnTurn, finalPromptCount }) => {
      const { harness, model, modelRef, modelRuntime } = createModelHarness();
      const controller = new AbortController();
      // No maxRuntimeMs: cancellation must not depend on (or wait for) a deadline.
      const runPromise = runCheckpointableAgent<WorkerReport>({
        ...lifecycleOptions(harness, modelRef, modelRuntime),
        abortSignal: controller.signal,
      });
      let caught: unknown;
      runPromise.catch((error: unknown) => {
        caught = error;
      });

      if (abortOnTurn === 2) {
        // Let turn 1 finish without submission so recovery opens.
        await harness.session.promptEntered(1);
        harness.session.resolveTurn(1);
        await harness.session.promptEntered(2);
      } else {
        await harness.session.promptEntered(1);
      }

      controller.abort();
      // The runner's listener fires synchronously: the session received its
      // abort before the active (scripted) prompt cooperated.
      expect(harness.session.abortCalls).toHaveLength(1);

      // The fake cooperates by settling the active prompt after abort notification.
      harness.session.resolveTurn(abortOnTurn);
      await flushMicrotasks();

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe(ABORT_MESSAGE);
      expect(harness.requests).toHaveLength(1);
      expect(harness.session.prompts).toHaveLength(finalPromptCount); // no subsequent prompts
      expect(harness.session.abortCalls).toHaveLength(1); // exactly one abort
      expect(harness.session.unsubscribeCalls).toBe(1); // exactly-once cleanup
      expect(harness.session.disposeCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("rejects for a pre-aborted signal without running any prompt", async () => {
    const { harness, model, modelRef, modelRuntime } = createModelHarness();
    const controller = new AbortController();
    controller.abort();

    const runPromise = runCheckpointableAgent<WorkerReport>({
      ...lifecycleOptions(harness, modelRef, modelRuntime),
      abortSignal: controller.signal,
    });
    await expect(runPromise).rejects.toThrow(ABORT_MESSAGE);

    expect(harness.requests).toHaveLength(1);
    expect(harness.session.prompts).toHaveLength(0);
    expect(harness.session.abortCalls).toHaveLength(1);
    expect(harness.session.unsubscribeCalls).toBe(1);
    expect(harness.session.disposeCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes the abort listener after settlement and ignores later aborts", async () => {
    const { harness, model, modelRef, modelRuntime } = createModelHarness();
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");

    const runPromise = runCheckpointableAgent<WorkerReport>({
      ...lifecycleOptions(harness, modelRef, modelRuntime),
      abortSignal: controller.signal,
    });

    await harness.session.promptEntered(1);
    await harness.session.submitResult(makeWorkerReportFixture());
    harness.session.resolveTurn(1);
    const outcome = await runPromise;
    expect(outcome.kind).toBe("result");

    // The single "abort" listener was removed with the same function reference.
    expect(addListener).toHaveBeenCalledTimes(1);
    expect(addListener.mock.calls[0][0]).toBe("abort");
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(removeListener.mock.calls[0][1]).toBe(addListener.mock.calls[0][1]);

    // A post-completion abort must not reach the session again.
    controller.abort();
    await flushMicrotasks();
    expect(harness.session.abortCalls).toHaveLength(0);
    expect(harness.session.unsubscribeCalls).toBe(1);
    expect(harness.session.disposeCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
