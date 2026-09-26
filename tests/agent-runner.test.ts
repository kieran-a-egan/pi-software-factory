import { describe, expect, it } from "vitest";

import { runAgent, type AgentRunResult } from "../src/agent-runner.js";
import type { ScoutResult } from "../src/types.js";
import { validateScout } from "../src/validate.js";
import {
  createAgentRunnerHarness,
  createModelHarness,
  makeScoutResultFixture,
  makeTurnEndEvent,
} from "./helpers/agent-runner-harness.js";

type ModelHarness = ReturnType<typeof createModelHarness>;

function startScoutRun(ctx: ModelHarness, prompt = "initial scout prompt") {
  return runAgent<ScoutResult>({
    role: "scout",
    cwd: "/fixture/cwd",
    model: ctx.modelRef,
    systemPrompt: "fixture system prompt",
    prompt,
    modelRuntime: ctx.modelRuntime,
    tools: ["read"],
    validate: validateScout,
    sessionFactory: ctx.harness.sessionFactory,
  });
}

describe("runAgent submission lifecycle with a scripted session", () => {
  it("returns the validated scout result when submit_result succeeds on the first turn", async () => {
    // First-turn success: only the initial prompt is permitted.
    const ctx = createModelHarness(1);
    const { harness, model } = ctx;
    const expected = makeScoutResultFixture();
    const run = startScoutRun(ctx);
    // Observe the run immediately and register unconditional cleanup before
    // any scenario assertion can fail.
    harness.trackRun(run);
    try {
      const firstPrompt = await harness.session.promptEntered(1);
      expect(firstPrompt).toBe("initial scout prompt");
      await harness.session.submitResult(expected);
      harness.session.emit(makeTurnEndEvent());
      harness.session.resolveTurn(1);

      const outcome: AgentRunResult<ScoutResult> = await run;

      expect(outcome.result).toEqual(expected);
      // One factory invocation.
      expect(harness.requests).toHaveLength(1);
      expect(harness.requests[0].model).toBe(model);
      expect(harness.requests[0].tools).toEqual(["read", "submit_result"]);
      expect(harness.session.registeredToolNames).toEqual(["submit_result"]);
      // One prompt.
      expect(harness.session.prompts).toHaveLength(1);
      expect(harness.session.steerCalls).toHaveLength(0);
      // Fixed token/cost/model metrics from the session stats fixture.
      expect(outcome.metrics.model).toBe("fake-provider/fake-model");
      expect(outcome.metrics.tokens).toEqual({
        input: 1_000,
        output: 500,
        cacheRead: 250,
        cacheWrite: 50,
        total: 1_800,
      });
      expect(outcome.metrics.cost).toBe(0.0123);
      expect(outcome.metrics.checkpointRequested).toBe(false);
      expect(outcome.metrics.submissionRecoveryAttempted).toBe(false);
      // Clean teardown without aborting a successful ordinary run.
      expect(harness.session.unsubscribeCalls).toBe(1);
      expect(harness.session.disposeCalls).toBe(1);
      expect(harness.session.abortCalls).toHaveLength(0);
    } finally {
      // Awaits the observed run outcome; idempotent.
      await harness.cleanup();
    }
  });

  it("recovers on the same session when the first turn omits submit_result", async () => {
    // Ordinary recovery: the initial prompt plus one recovery prompt.
    const ctx = createModelHarness(2);
    const { harness } = ctx;
    const expected = makeScoutResultFixture();
    const run = startScoutRun(ctx);
    harness.trackRun(run);
    try {
      // Turn one ends without any submission.
      await harness.session.promptEntered(1);
      harness.session.resolveTurn(1);

      // The recovery prompt arrives on the same session.
      const recoveryPrompt = await harness.session.promptEntered(2);
      expect(recoveryPrompt).toContain("FACTORY STRUCTURED SUBMISSION REQUIRED");
      expect(recoveryPrompt).toContain("call submit_result exactly once");
      // Distinguish the plain result-recovery instruction from checkpoint recovery.
      expect(recoveryPrompt).not.toContain("context checkpoint was requested");

      await harness.session.submitResult(expected);
      harness.session.emit(makeTurnEndEvent());
      harness.session.resolveTurn(2);

      const outcome = await run;

      expect(outcome.result).toEqual(expected);
      // One factory invocation and exactly two prompts on the same session.
      expect(harness.requests).toHaveLength(1);
      expect(harness.session.prompts).toHaveLength(2);
      expect(outcome.metrics.submissionRecoveryAttempted).toBe(true);
      expect(outcome.metrics.checkpointRequested).toBe(false);
      // Same clean teardown as the first-turn path.
      expect(harness.session.unsubscribeCalls).toBe(1);
      expect(harness.session.disposeCalls).toBe(1);
      expect(harness.session.abortCalls).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("fails with the submission error when both turns omit submit_result and never attempts a third turn", async () => {
    // Two-turn submission failure: exactly the initial and recovery prompts.
    const ctx = createModelHarness(2);
    const { harness } = ctx;
    const run = startScoutRun(ctx);
    harness.trackRun(run);
    try {
      // Turn one: no submission.
      await harness.session.promptEntered(1);
      harness.session.resolveTurn(1);
      // Turn two (recovery): still no submission.
      await harness.session.promptEntered(2);
      expect(harness.session.prompts[1]).toContain("FACTORY STRUCTURED SUBMISSION REQUIRED");
      harness.session.resolveTurn(2);

      await expect(run).rejects.toThrow("scout agent finished without calling submit_result");

      // Exactly two prompts; the run is over, and the declared bound of two
      // turns structurally prevents any third turn from being attempted.
      expect(harness.requests).toHaveLength(1);
      expect(harness.session.prompts).toHaveLength(2);
      // The failure path still unsubscribes and disposes exactly once.
      expect(harness.session.unsubscribeCalls).toBe(1);
      expect(harness.session.disposeCalls).toBe(1);
      expect(harness.session.abortCalls).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });
});

describe("bounded harness corrections", () => {
  it("rejects an excess prompt immediately with the attempted turn and bound", async () => {
    const { harness } = createModelHarness(2);
    try {
      // Turns one and two are within the declared bound...
      expect(() => harness.session.prompt("first prompt")).not.toThrow();
      expect(() => harness.session.prompt("second prompt")).not.toThrow();
      // ...but the third prompt rejects immediately with a diagnostic that
      // identifies the attempted turn and the bound, without allocating a
      // pending turn.
      expect(() => harness.session.prompt("third prompt")).toThrow(
        /harness: prompt for turn 3 exceeds the expected-turn bound of 2/,
      );
      expect(harness.session.prompts).toHaveLength(2);
      // The entry barrier refuses to wait for a turn beyond the bound.
      await expect(harness.session.promptEntered(3)).rejects.toThrow(
        /harness: turn index 3 exceeds the expected-turn bound of 2/,
      );
    } finally {
      // Unconditional cleanup: even if any assertion above threw, the two
      // entered pending turns are settled before the test tears down.
      await harness.cleanup();
      expect(harness.session.turnSettled(1)).toBe(true);
      expect(harness.session.turnSettled(2)).toBe(true);
      // Repeated cleanup is a no-op once terminal mode is entered.
      await expect(harness.cleanup()).resolves.toBeUndefined();
      expect(harness.cleaningUp).toBe(true);
    }
  });

  it("enforces the prompt bound for a prompt that arrives after cleanup begins", async () => {
    const { harness } = createModelHarness(1);
    const session = harness.session;
    session.prompt("the only permitted turn");
    try {
      // Terminal cleanup settles the one permitted, pending turn.
      await harness.cleanup();
      expect(session.turnSettled(1)).toBe(true);
      // Overflow is still diagnosed once cleanup has begun: the second prompt
      // exceeds the declared bound and rejects immediately rather than being
      // recorded as pending work.
      expect(() => session.prompt("overflow during cleanup")).toThrow(
        /harness: prompt for turn 2 exceeds the expected-turn bound of 1/,
      );
      expect(session.prompts).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("auto-settles manual steer/abort calls that arrive during terminal cleanup", async () => {
    const harness = createAgentRunnerHarness(2, {
      steerSettleBehavior: "manual",
      abortSettleBehavior: "manual",
    });
    const session = harness.session;

    try {
      session.prompt("turn one");

      // Manual steer/abort calls recorded before cleanup stay pending...
      const earlySteer = session.steer("early steer");
      const earlyAbort = session.abort();

      // These assertions are deliberately inside the try boundary: if either
      // fails, the finally block still settles all outstanding scripted work.
      expect(session.steerCalls[0].settled.settled).toBe(false);
      expect(session.abortCalls[0].settled).toBe(false);

      // ...and cleanup settles them together with the pending turn.
      await harness.cleanup();
      await earlySteer;
      await earlyAbort;
      expect(session.turnSettled(1)).toBe(true);

      // A continuation that records fresh manual calls while already in
      // terminal cleanup mode must never leave them pending.
      const lateSteer = session.steer("late steer during cleanup");
      const lateAbort = session.abort();
      await lateSteer;
      await lateAbort;

      // Repeated cleanup is a no-op and leaves no recorded call pending.
      await harness.cleanup();
      expect(session.steerCalls.every((call) => call.settled.settled)).toBe(true);
      expect(session.abortCalls.every((call) => call.settled)).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  it("observes a non-rejecting discriminated outcome and entry waits that fail before entry", async () => {
    const { harness } = createModelHarness(1);
    // A run that rejects immediately; trackRun attaches both settlement
    // handlers synchronously so the raw rejection is observed, not unhandled.
    const run = (async () => {
      throw new Error("observed rejection");
    })();
    harness.trackRun(run);
    // The observer promise fulfills with the discriminated rejected outcome.
    const outcome = await harness.runOutcome.promise;
    expect(outcome.state).toBe("rejected");
    if (outcome.state !== "rejected") throw new Error("unreachable: expected rejected outcome");
    expect(outcome.error).toBeInstanceOf(Error);
    // An entry wait for a turn that will never be entered rejects
    // diagnostically once the observed run has already settled.
    await expect(harness.session.promptEntered(1)).rejects.toThrow(
      /run settled before turn 1 was entered/,
    );
  });

  it("completes cleanup after a deliberate caught scenario failure that would otherwise open recovery", async () => {
    // Two permitted turns: a failure while turn one is still pending would
    // otherwise leave a pending turn that, once settled, opens the recovery
    // prompt.
    const ctx = createModelHarness(2);
    const { harness } = ctx;
    const run = startScoutRun(ctx);
    harness.trackRun(run);

    let scenarioError: unknown;
    try {
      await harness.session.promptEntered(1);
      // Deliberate scenario failure on the first turn: the scripted turn is
      // still pending and no submission has been recorded.
      throw new Error("deliberate scenario failure: first-turn assertion failed");
    } catch (error) {
      scenarioError = error;
    } finally {
      await harness.cleanup();
    }

    // The original failure remains observable and untouched.
    expect(scenarioError).toBeInstanceOf(Error);
    expect((scenarioError as Error).message).toBe(
      "deliberate scenario failure: first-turn assertion failed",
    );

    // Cleanup settled the pending first turn; the runner's recovery prompt
    // then arrived in terminal cleanup mode, was recorded, and never became
    // pending work.
    expect(harness.session.prompts).toHaveLength(2);
    expect(harness.session.prompts[1]).toContain("FACTORY STRUCTURED SUBMISSION REQUIRED");
    // The run settled with its normal no-submission rejection; cleanup
    // observed the outcome without rethrowing it.
    expect(harness.runOutcome.state).toBe("rejected");
    const rejection = harness.runOutcome.rejection;
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain(
      "scout agent finished without calling submit_result",
    );
    // Teardown still happens exactly once, without aborting.
    expect(harness.session.unsubscribeCalls).toBe(1);
    expect(harness.session.disposeCalls).toBe(1);
    expect(harness.session.abortCalls).toHaveLength(0);
    // Repeated cleanup is safe and has no further effect.
    await expect(harness.cleanup()).resolves.toBeUndefined();
    expect(harness.cleaningUp).toBe(true);
  });
});
