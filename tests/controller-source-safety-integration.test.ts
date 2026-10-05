import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as agents from "../src/agent-runner.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { runFactory } from "../src/controller.js";
import * as gitEvidence from "../src/git-evidence.js";
import { JevDecisionEngine } from "../src/jev.js";
import type { ArchitectureResult, FactoryConfig, FactoryRunState, ModelRef, ReviewGateDecision, ReviewResult } from "../src/types.js";
import { makeFakeModelRuntime, makeScoutResultFixture, makeWorkerReportFixture } from "./helpers/agent-runner-harness.js";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await exec("git", args, { cwd, windowsHide: true })).stdout;
}
const runnerMetrics = (model: ModelRef): agents.AgentRunMetrics => ({
  model: `${model.provider}/${model.model}`, cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
let cwd: string;
let config: FactoryConfig;
let architecture: ArchitectureResult;
let review: ReviewResult;
let gate: ReviewGateDecision;
let writeWorker: (options: agents.RunCheckpointableAgentOptions<unknown>) => Promise<void>;
let workerCalls: number;
let originalHead: string;

const json = (dir: string, file: string) => JSON.parse(readFileSync(join(dir, file), "utf8"));
const runDir = (state: FactoryRunState) => join(cwd, config.runRoot, state.id);
const lockPath = () => join(cwd, ".git", "pi-software-factory.lock");
const run = (signal?: AbortSignal) => runFactory(cwd, "fixture reliability change", config, () => {}, signal);
const workerId = (prompt: string) => /"currentUnit":\s*\{\s*"id": "([^"]+)"/.exec(prompt)?.[1] ?? "a";

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), "pi-sf-controller-test-"));
  await git(cwd, "init", "-b", "main");
  await git(cwd, "config", "user.name", "Test");
  await git(cwd, "config", "user.email", "test@local.invalid");
  await git(cwd, "config", "commit.gpgsign", "false");
  await git(cwd, "config", "core.autocrlf", "false");
  writeFileSync(join(cwd, "a.txt"), "baseline a\n");
  writeFileSync(join(cwd, "b.txt"), "baseline b\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", "baseline");
  originalHead = await git(cwd, "rev-parse", "HEAD");
  config = structuredClone(DEFAULT_CONFIG);
  config.parallelImplementation.enabled = false;
  architecture = {
    summary: "fixture", approach: "bounded", architecturalDecisions: [], risks: [], assumptions: [], verificationStrategy: [],
    implementationUnits: ["a", "b"].map((id) => ({ id, objective: id, acceptance: [], constraints: [], dependsOn: [] })),
  };
  review = { summary: "clean", verdict: "clean", findings: [], testGaps: [], requirementCoverage: [] };
  gate = { action: "accept", confidence: 1, residualRisk: "low", reviewSufficientProbability: 0.57, raw: { score: 0.57 } };
  workerCalls = 0;
  writeWorker = async (options) => {
    const id = workerId(options.prompt);
    writeFileSync(join(options.cwd, `${id}.txt`), `implemented ${id}\n`);
  };
  vi.stubEnv("TYPESAFE_API_KEY", "offline-fixture");
  vi.spyOn(ModelRuntime, "create").mockResolvedValue(makeFakeModelRuntime());
  vi.spyOn(JevDecisionEngine.prototype, "classifyIntake").mockResolvedValue({
    taskType: "bug", requirementClarity: "clear", statedRisk: "low", confidence: { requirementClarity: 1 }, raw: {},
  });
  vi.spyOn(JevDecisionEngine.prototype, "gatePlan").mockResolvedValue({
    action: "proceed", confidence: 1, planCompleteProbability: 1, implementationRisk: "low", rescoutFocus: "none", replanFocus: "none", raw: {},
  });
  vi.spyOn(JevDecisionEngine.prototype, "gateWorker").mockResolvedValue({ disposition: "ready", confidence: 1, raw: {} });
  vi.spyOn(JevDecisionEngine.prototype, "gateReview").mockImplementation(async () => structuredClone(gate));
  vi.spyOn(agents, "runAgent").mockImplementation(async (options) => {
    return {
      result: options.validate(
        options.role === "scout" ? makeScoutResultFixture()
          : options.role === "architect" ? architecture
          : review,
      ), metrics: runnerMetrics(options.model),
    };
  });
  vi.spyOn(agents, "runCheckpointableAgent").mockImplementation(async (options) => {
    workerCalls++;
    await writeWorker(options);
    const id = workerId(options.prompt);
    return { kind: "result", result: options.validate(makeWorkerReportFixture({ unitId: id, changedFiles: [`${id}.txt`] })), metrics: runnerMetrics(options.model) };
  });
});

afterEach(async () => {
  try {
    if (cwd) {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

describe("controller source safety integration", () => {
  it("retains partial sequential edits on HUMAN, and blocks another run even with clean-tree checking disabled", async () => {
    vi.mocked(JevDecisionEngine.prototype.gateWorker).mockResolvedValueOnce({ disposition: "ready", confidence: 1, raw: {} })
      .mockResolvedValueOnce({ disposition: "blocked", confidence: 1, raw: {} });
    const state = await run();
    expect(workerCalls).toBe(2);
    expect(state.finalStatus).toBe("human");
    expect(state.sourceDisposition?.disposition).toBe("retained-unaccepted");
    expect(json(runDir(state), "source-before.json").diff).toBe("");
    expect(json(runDir(state), "source-after.json").diff).toContain("implemented a");
    expect(json(runDir(state), "source-after.json").diff).toContain("implemented b");
    expect(existsSync(lockPath())).toBe(true);
    config.requireCleanWorkingTree = false;
    const blocked = await run();
    expect(blocked.id).not.toBe(state.id);
    expect(blocked.finalStatus).toBe("blocked");
    expect(blocked.finalReason).toContain("source safety interlock");
    expect(workerCalls).toBe(2);
    expect(json(runDir(state), "state.json").finalStatus).toBe("human");
    expect(await git(cwd, "rev-parse", "HEAD")).toBe(originalHead);
  });

  it("persists FAILED and retains edits when a later worker throws", async () => {
    writeWorker = async (options) => {
      writeFileSync(join(options.cwd, workerCalls === 1 ? "a.txt" : "b.txt"), "partial implementation\n");
      if (workerCalls === 2) throw new Error("injected worker failure");
    };
    const state = await run();
    expect(state.finalStatus).toBe("failed");
    expect(state.finalReason).toContain("injected worker failure");
    expect(state.sourceDisposition?.disposition).toBe("unknown-retained");
    expect(json(runDir(state), "state.json").finalStatus).toBe("failed");
    expect(json(runDir(state), "source-after.json").diff).toContain("partial implementation");
    expect(existsSync(lockPath())).toBe(true);
  });

  it("retains cancellation evidence and never treats partial work as accepted", async () => {
    const abort = new AbortController();
    writeWorker = async (options) => {
      writeFileSync(join(options.cwd, "a.txt"), "cancelled partial\n");
      expect(options.abortSignal).toBe(abort.signal);
      abort.abort();
    };
    const state = await run(abort.signal);
    expect(state.finalStatus).toBe("human");
    expect(state.finalReason).toContain("cancelled");
    expect(state.sourceDisposition?.disposition).toBe("unknown-retained");
    expect(workerCalls).toBe(1);
    expect(existsSync(lockPath())).toBe(true);
    expect(json(runDir(state), "source-after.json").diff).toContain("cancelled partial");
  });

  it("fails closed if terminal source capture fails", async () => {
    const capture = gitEvidence.captureGitEvidence;
    vi.mocked(JevDecisionEngine.prototype.gateReview).mockImplementation(async () => {
      vi.spyOn(gitEvidence, "captureGitEvidence").mockRejectedValueOnce(new Error("terminal capture unavailable"));
      return gate;
    });
    const state = await run();
    expect(state.finalStatus).toBe("human");
    expect(state.sourceDisposition?.disposition).toBe("unknown-retained");
    expect(state.finalReason).toContain("terminal capture unavailable");
    expect(existsSync(lockPath())).toBe(true);
    vi.mocked(gitEvidence.captureGitEvidence).mockImplementation(capture);
  });

  it("does not accept cancellation arriving during terminal evidence capture", async () => {
    const abort = new AbortController();
    const capture = gitEvidence.captureGitEvidence;
    vi.mocked(JevDecisionEngine.prototype.gateReview).mockImplementation(async () => {
      vi.spyOn(gitEvidence, "captureGitEvidence").mockImplementationOnce(async (...args) => {
        const evidence = await capture(...args);
        abort.abort();
        return evidence;
      });
      return gate;
    });
    const state = await run(abort.signal);
    expect(state.finalStatus).toBe("human");
    expect(state.sourceDisposition?.disposition).toBe("unknown-retained");
    expect(state.finalReason).toContain("cancelled");
    expect(existsSync(lockPath())).toBe(true);
  });

  it("refuses acceptance when source changes during review after verification", async () => {
    vi.mocked(JevDecisionEngine.prototype.gateReview).mockImplementation(async () => {
      writeFileSync(join(cwd, "a.txt"), "unverified concurrent change\n");
      return gate;
    });
    const state = await run();
    expect(state.reviewRouting?.outcome).toBe("bounded-low-sufficiency-acceptance");
    expect(state.finalStatus).toBe("human");
    expect(state.finalReason).toContain("Source changed after authoritative verification");
    expect(state.sourceDisposition?.disposition).toBe("unknown-retained");
  });

}, 30_000);
