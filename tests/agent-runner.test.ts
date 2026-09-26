import { describe, expect, it } from "vitest";

import { runAgent, type AgentRunResult } from "../src/agent-runner.js";
import type { ScoutResult } from "../src/types.js";
import { validateScout } from "../src/validate.js";
import { createModelHarness, makeScoutResultFixture } from "./helpers/agent-runner-harness.js";

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
    const ctx = createModelHarness();
    const { harness, model } = ctx;
    const expected = makeScoutResultFixture();
    const run = startScoutRun(ctx);

    const firstPrompt = await harness.session.promptEntered(1);
    expect(firstPrompt).toBe("initial scout prompt");
    await harness.session.submitResult(expected);
    harness.session.emit({ type: "turn_end" });
    harness.session.resolveTurn(1);

    const outcome: AgentRunResult<ScoutResult> = await run;

    expect(outcome.result).toEqual(expected);
    // One factory invocation.
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0].model).toBe(model);
    expect(harness.requests[0].tools).toEqual(["read", "submit_result"]);
    expect(harness.requests[0].customTools.map((tool: any) => tool.name)).toEqual(["submit_result"]);
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
  });

  it("recovers on the same session when the first turn omits submit_result", async () => {
    const ctx = createModelHarness();
    const { harness } = ctx;
    const expected = makeScoutResultFixture();
    const run = startScoutRun(ctx);

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
    harness.session.emit({ type: "turn_end" });
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
  });

  it("fails with the submission error when both turns omit submit_result and never attempts a third turn", async () => {
    const ctx = createModelHarness();
    const { harness } = ctx;
    const run = startScoutRun(ctx);

    // Turn one: no submission.
    await harness.session.promptEntered(1);
    harness.session.resolveTurn(1);
    // Turn two (recovery): still no submission.
    await harness.session.promptEntered(2);
    expect(harness.session.prompts[1]).toContain("FACTORY STRUCTURED SUBMISSION REQUIRED");
    harness.session.resolveTurn(2);

    await expect(run).rejects.toThrow("scout agent finished without calling submit_result");

    // Exactly two prompts; the run is over, so no third turn can be attempted.
    expect(harness.requests).toHaveLength(1);
    expect(harness.session.prompts).toHaveLength(2);
    // The failure path still unsubscribes and disposes exactly once.
    expect(harness.session.unsubscribeCalls).toBe(1);
    expect(harness.session.disposeCalls).toBe(1);
    expect(harness.session.abortCalls).toHaveLength(0);
  });
});
