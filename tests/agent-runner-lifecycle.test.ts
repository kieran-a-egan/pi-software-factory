/**
 * Deterministic lifecycle coverage for src/agent-runner.ts: the overall
 * maxRuntimeMs deadline must span both the initial turn and submission
 * recovery, and external AbortController cancellation must terminate
 * cooperative (scripted) sessions exactly once, without waiting for any
 * deadline.
 *
 * All time is virtual: fake Date/setTimeout/clearTimeout with a fixed
 * nonzero epoch. No real sleeps, polling, models, network, or Git.
 *
 * Synchronization is explicit and deterministic:
 * - prompt-entry barriers (`promptEntered`) gate each scripted turn,
 * - the run outcome is observed through `harness.runOutcome` (attached via
 *   `trackRun` before any assertion),
 * - fake timers are advanced asynchronously (`advanceTimersByTimeAsync`)
 *   wherever promise callbacks accompany timer execution, and
 * - idempotent `harness.cleanup()` is registered in `try/finally` so it is
 *   always awaited before fake timers are cleared/restored.
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
import type { ModelRef, WorkerReport } from "../src/types.js";
import { validateWorkerCheckpoint, validateWorkerReport } from "../src/validate.js";
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

/**
 * Common checkpointable-run options for these lifecycle scenarios. The real
 * lifecycle validators are used end-to-end, and the context budget is
 * disabled so checkpoint machinery cannot interfere with deadline/cancellation
 * behavior.
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
    validate: validateWorkerReport,
    sessionFactory: harness.sessionFactory,
    contextBudget: makeDisabledContextBudget(),
    validateCheckpoint: validateWorkerCheckpoint,
  };
}

/**
 * Consume the observed run outcome and return its rejection error. The
 * observer promise is non-rejecting — it always fulfills with a discriminated
 * outcome — so this unwraps the `rejected` state directly. It only throws when
 * the run did not reject, which is itself a scenario error.
 */
function awaitRejectedOutcome(harness: AgentRunnerHarness): Promise<unknown> {
  return harness.runOutcome.promise.then((result) => {
    if (result.state !== "rejected") {
      throw new Error(`expected a rejected run outcome, observed ${result.state}`);
    }
    return result.error;
  });
}

describe("agent runner lifecycle: shared deadline and external abort", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);
  });

  afterEach(() => {
    // Safety net only — every scenario awaits harness.cleanup() in its
    // finally block before reaching this point, so no runner timer or fake
    // clock should be leaking from the scenario itself.
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("applies the overall deadline across initial work and recovery, not per-prompt", async () => {
    // Two turns: initial work plus submission recovery, both inside the one
    // shared 60s budget.
    const { harness, modelRef, modelRuntime } = createModelHarness(2);
    const runPromise = runCheckpointableAgent<WorkerReport>({
      ...lifecycleOptions(harness, modelRef, modelRuntime),
      maxRuntimeMs: MAX_RUNTIME_MS,
    });
    harness.trackRun(runPromise);
    try {
      // t = 0: initial turn entered.
      await harness.session.promptEntered(1);

      // t = 0..40_000: the deadline timer ticks alongside promise work, so
      // advance the fake clock asynchronously.
      await vi.advanceTimersByTimeAsync(40_000);
      harness.session.resolveTurn(1); // t = 40_000: initial work done, no submission

      // t = 40_000: recovery opens within the same 60s budget and is held open.
      await harness.session.promptEntered(2);
      expect(harness.session.prompts[1]).toContain("FACTORY STRUCTURED SUBMISSION REQUIRED");

      // t = 59_999: one virtual ms before the shared deadline. The run is
      // pending, the active recovery turn is still open, no abort has fired yet,
      // and the runner's deadline timer (armed for t = 60_000) is still present.
      await vi.advanceTimersByTimeAsync(19_999);
      expect(harness.runOutcome.settled).toBe(false);
      expect(harness.session.turnSettled(2)).toBe(false);
      expect(harness.session.abortCalls).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(1);

      // t = 60_000: the shared deadline fires — 20s after recovery started, not 60s.
      await vi.advanceTimersByTimeAsync(1);

      // Await the observed rejection rather than draining microtasks.
      const rejection = await awaitRejectedOutcome(harness);
      expect(harness.runOutcome.state).toBe("rejected");
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toBe(TIMEOUT_MESSAGE);

      // Run settlement is not prompt settlement: the deadline rejected the
      // runner, but the scripted recovery prompt it raced is still pending here.
      expect(harness.session.turnSettled(2)).toBe(false);

      // One factory invocation, exactly two prompts, deadline-triggered abort,
      // exactly-once cleanup, and no runner timer left behind after timeout.
      expect(harness.requests).toHaveLength(1);
      expect(harness.session.prompts).toHaveLength(2);
      expect(harness.session.abortCalls).toHaveLength(1);
      expect(harness.session.unsubscribeCalls).toBe(1);
      expect(harness.session.disposeCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);

      // Cleanup settles the raced pending prompt independently of the
      // already-completed runner teardown (idempotent; the finally block
      // re-invokes it as a no-op).
      await harness.cleanup();
      expect(harness.session.turnSettled(2)).toBe(true);
    } finally {
      // Always await cleanup before fake timers are cleared/restored.
      await harness.cleanup();
    }
  });

  it("completes a recovery inside the budget and leaves no leaked deadline timer", async () => {
    const { harness, modelRef, modelRuntime } = createModelHarness(2);
    const runPromise = runCheckpointableAgent<WorkerReport>({
      ...lifecycleOptions(harness, modelRef, modelRuntime),
      maxRuntimeMs: MAX_RUNTIME_MS,
    });
    harness.trackRun(runPromise);
    try {
      // t = 40_000: initial turn finishes without submission.
      await harness.session.promptEntered(1);
      await vi.advanceTimersByTimeAsync(40_000);
      harness.session.resolveTurn(1);

      // t = 40_000..55_000: recovery submits successfully, well within the budget.
      await harness.session.promptEntered(2);
      await harness.session.submitResult(makeWorkerReportFixture());
      await vi.advanceTimersByTimeAsync(15_000);
      harness.session.resolveTurn(2);

      const outcome = await runPromise;
      expect(harness.runOutcome.state).toBe("fulfilled");
      expect(outcome.kind).toBe("result");
      if (outcome.kind !== "result") throw new Error("unreachable: expected result outcome");
      expect(outcome.result).toEqual(makeWorkerReportFixture());

      // The deadline timer must be cleared on success; a leaked timer would
      // later call session.abort() on an already completed run.
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000); // well past the original budget
      expect(harness.session.abortCalls).toHaveLength(0);

      expect(harness.requests).toHaveLength(1);
      expect(harness.session.prompts).toHaveLength(2);
      expect(harness.session.unsubscribeCalls).toBe(1);
      expect(harness.session.disposeCalls).toBe(1);
    } finally {
      await harness.cleanup();
    }
  });

  it.each([
    { label: "during the initial turn", abortOnTurn: 1, finalPromptCount: 1 },
    { label: "during submission recovery", abortOnTurn: 2, finalPromptCount: 2 },
  ])(
    "terminates the run when the controller aborts $label",
    async ({ abortOnTurn, finalPromptCount }) => {
      // The declared bound is the parameterized final prompt count for this
      // abort case: no prompt beyond the aborted one may be issued.
      const { harness, modelRef, modelRuntime } = createModelHarness(finalPromptCount);
      const controller = new AbortController();
      // No maxRuntimeMs: cancellation must not depend on (or wait for) a deadline.
      const runPromise = runCheckpointableAgent<WorkerReport>({
        ...lifecycleOptions(harness, modelRef, modelRuntime),
        abortSignal: controller.signal,
      });
      harness.trackRun(runPromise);
      try {
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

        // The fake cooperates by settling the active prompt after abort
        // notification; settlement propagates through pure microtask work, so
        // awaiting the observed outcome is deterministic.
        harness.session.resolveTurn(abortOnTurn);
        const rejection = await awaitRejectedOutcome(harness);

        expect(rejection).toBeInstanceOf(Error);
        expect((rejection as Error).message).toBe(ABORT_MESSAGE);
        expect(harness.requests).toHaveLength(1);
        expect(harness.session.prompts).toHaveLength(finalPromptCount); // no subsequent prompts
        expect(harness.session.abortCalls).toHaveLength(1); // exactly one abort
        expect(harness.session.unsubscribeCalls).toBe(1); // exactly-once cleanup
        expect(harness.session.disposeCalls).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await harness.cleanup();
      }
    },
  );

  it("rejects for a pre-aborted signal without running any prompt", async () => {
    // One permitted turn is declared, but the pre-aborted run must never use it.
    const { harness, modelRef, modelRuntime } = createModelHarness(1);
    const controller = new AbortController();
    controller.abort();

    const runPromise = runCheckpointableAgent<WorkerReport>({
      ...lifecycleOptions(harness, modelRef, modelRuntime),
      abortSignal: controller.signal,
    });
    harness.trackRun(runPromise);
    try {
      await expect(runPromise).rejects.toThrow(ABORT_MESSAGE);
      expect(harness.runOutcome.state).toBe("rejected");

      expect(harness.requests).toHaveLength(1);
      expect(harness.session.prompts).toHaveLength(0); // zero actual prompts
      expect(harness.session.abortCalls).toHaveLength(1);
      expect(harness.session.unsubscribeCalls).toBe(1);
      expect(harness.session.disposeCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("removes the abort listener after settlement and ignores later aborts", async () => {
    const { harness, modelRef, modelRuntime } = createModelHarness(1);
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");

    const runPromise = runCheckpointableAgent<WorkerReport>({
      ...lifecycleOptions(harness, modelRef, modelRuntime),
      abortSignal: controller.signal,
    });
    harness.trackRun(runPromise);
    try {
      await harness.session.promptEntered(1);
      await harness.session.submitResult(makeWorkerReportFixture());
      harness.session.resolveTurn(1);
      const outcome = await runPromise;
      expect(harness.runOutcome.state).toBe("fulfilled");
      expect(outcome.kind).toBe("result");

      // The single "abort" listener was removed with the same function reference.
      expect(addListener).toHaveBeenCalledTimes(1);
      expect(addListener.mock.calls[0][0]).toBe("abort");
      expect(removeListener).toHaveBeenCalledTimes(1);
      expect(removeListener.mock.calls[0][1]).toBe(addListener.mock.calls[0][1]);

      // A post-completion abort must not reach the session again. The
      // listener is already removed, so this is a synchronous no-effect check.
      controller.abort();
      expect(harness.session.abortCalls).toHaveLength(0);
      expect(harness.session.unsubscribeCalls).toBe(1);
      expect(harness.session.disposeCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await harness.cleanup();
    }
  });
});
