import { describe, expect, it } from "vitest";

import { runCheckpointableAgent, writeTools } from "../src/agent-runner.js";
import type { ContextUsageSnapshot, WorkerReport } from "../src/types.js";
import { validateWorkerCheckpoint, validateWorkerReport } from "../src/validate.js";
import {
  createModelHarness,
  makeCheckpointFixture,
  makeContextBudget,
  makeContextUsage,
} from "./helpers/agent-runner-harness.js";

describe("runCheckpointableAgent checkpoint-capable recovery with a scripted session", () => {
  it("returns kind='checkpoint' when the post-checkpoint recovery turn submits a valid checkpoint", async () => {
    const ctx = createModelHarness({ contextWindow: 100_000 });
    const { harness } = ctx;
    const budget = makeContextBudget();
    // Enabled budget (warning 40k / checkpoint 60k / hard 80k) with the fake
    // model window (100k) strictly above hardLimitTokens.
    expect(budget.enabled).toBe(true);
    expect(budget.checkpointTokens).toBe(60_000);
    expect(budget.hardLimitTokens).toBeLessThan(100_000);

    const contextEvents: Array<{ level: "warning" | "checkpoint"; usage: ContextUsageSnapshot }> = [];
    const expectedCheckpoint = makeCheckpointFixture();

    const run = runCheckpointableAgent<WorkerReport>({
      role: "implementer",
      cwd: "/fixture/cwd",
      model: ctx.modelRef,
      systemPrompt: "fixture system prompt",
      prompt: "implement the approved unit",
      modelRuntime: ctx.modelRuntime,
      tools: writeTools(),
      validate: validateWorkerReport,
      contextBudget: budget,
      validateCheckpoint: validateWorkerCheckpoint,
      onContext: (level, usage) => contextEvents.push({ level, usage }),
      sessionFactory: harness.sessionFactory,
    });

    // --- Turn one: cross the checkpoint threshold without any submission ----
    const firstPrompt = await harness.session.promptEntered(1);
    expect(firstPrompt).toBe("implement the approved unit");

    // Context usage crosses warningTokens and checkpointTokens; a subscribed
    // event drives the runner's context inspection.
    harness.session.contextUsage = makeContextUsage(65_000);
    harness.session.emit({ type: "tool_execution_end" });

    // The checkpoint callback fired at the crossed usage...
    expect(contextEvents.map((event) => event.level)).toEqual(["warning", "checkpoint"]);
    expect(contextEvents[1]?.usage).toEqual({ tokens: 65_000, contextWindow: 100_000, percent: 65 });
    // ...and the checkpoint steering is recorded before recovery starts.
    expect(harness.session.steerCalls).toHaveLength(1);
    expect(harness.session.steerCalls[0].text).toContain("FACTORY CONTEXT BUDGET CHECKPOINT REQUIRED");
    expect(harness.session.steerCalls[0].text).toContain("call submit_checkpoint exactly once");
    await harness.session.steerCalls[0].settled.promise;

    // End the turn without submit_result or submit_checkpoint.
    harness.session.resolveTurn(1);

    // The second prompt is the checkpoint-capable recovery on the same session.
    const recoveryPrompt = await harness.session.promptEntered(2);
    expect(recoveryPrompt).toContain("FACTORY STRUCTURED SUBMISSION REQUIRED");
    expect(recoveryPrompt).toContain("context checkpoint was requested");
    expect(recoveryPrompt).toContain("Otherwise call submit_checkpoint exactly once");
    expect(recoveryPrompt).not.toContain("Do not continue investigation, implementation, review");
    // No further steering after the checkpoint was already requested.
    expect(harness.session.steerCalls).toHaveLength(1);

    // --- Turn two: usage changes before the real checkpoint submission ------
    // Bump usage after the checkpoint snapshot was taken so the returned
    // context can be distinguished from later usage.
    harness.session.contextUsage = makeContextUsage(75_000);
    harness.session.emit({ type: "turn_end" });

    // Invoke the actual submit_checkpoint tool with its real envelope.
    await harness.session.submitCheckpoint(expectedCheckpoint);
    harness.session.resolveTurn(2);

    const outcome = await run;

    expect(outcome.kind).toBe("checkpoint");
    if (outcome.kind !== "checkpoint") throw new Error("unreachable: expected checkpoint outcome");
    expect(outcome.checkpoint).toEqual(expectedCheckpoint);
    // The context snapshot is the one captured when checkpointing was first
    // requested (65k), not the later 75k usage.
    expect(outcome.context).toEqual({ tokens: 65_000, contextWindow: 100_000, percent: 65 });

    // Exactly one factory invocation; exactly two prompts on the same session.
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0].contextBudget).toBe(budget);
    expect(harness.requests[0].customTools.map((tool: any) => tool.name)).toEqual([
      "submit_result",
      "submit_checkpoint",
    ]);
    expect(harness.requests[0].tools).toEqual([...writeTools(), "submit_result", "submit_checkpoint"]);
    expect(harness.session.prompts).toHaveLength(2);

    // Metrics record the checkpoint path and the later max usage.
    expect(outcome.metrics.checkpointRequested).toBe(true);
    expect(outcome.metrics.submissionRecoveryAttempted).toBe(true);
    expect(outcome.metrics.maxContextTokens).toBe(75_000);
    expect(outcome.metrics.contextWindow).toBe(100_000);

    // Exactly-once teardown, no abort on the successful checkpoint path.
    expect(harness.session.unsubscribeCalls).toBe(1);
    expect(harness.session.disposeCalls).toBe(1);
    expect(harness.session.abortCalls).toHaveLength(0);
  });
});
