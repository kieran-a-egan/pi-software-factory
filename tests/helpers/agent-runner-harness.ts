/**
 * Test-only scripted harness for exercising src/agent-runner.ts without any
 * SDK session construction, model calls, network access, or repository tools.
 *
 * The harness implements the runner's structural `AgentRunnerSession` seam and
 * records every factory request and session method call. Prompts are deferred:
 * `prompt()` returns a promise that stays pending until the test resolves the
 * turn, so tests can call the real submission tool closures (registered via
 * `AgentSessionFactoryRequest.customTools`) at exactly the moment they need.
 */
import type {
  AgentSessionEvent,
  AgentSessionEventListener,
  ContextUsage,
  ModelRuntime,
  SessionStats,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentRunnerSession,
  AgentSessionFactory,
  AgentSessionFactoryRequest,
  ResolvedAgentModel,
} from "../../src/agent-runner.js";
import type {
  ContextBudgetConfig,
  ModelRef,
  ScoutResult,
  WorkerCheckpoint,
  WorkerReport,
} from "../../src/types.js";

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (error?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = (error?: unknown) => reject(error);
  });
  return { promise, resolve: (value: T) => resolveFn(value), reject: rejectFn };
}

/** A recorded call whose settlement (resolve/reject) is observable and controllable. */
export class SettledCall {
  readonly promise: Promise<void>;
  #resolve!: () => void;
  #reject!: (error?: unknown) => void;
  #settled = false;

  constructor() {
    this.promise = new Promise<void>((resolve, reject) => {
      this.#resolve = () => {
        this.#settled = true;
        resolve();
      };
      this.#reject = (error?: unknown) => {
        this.#settled = true;
        reject(error);
      };
    });
  }

  resolve(): void {
    if (!this.#settled) this.#resolve();
  }

  reject(error?: unknown): void {
    if (!this.#settled) this.#reject(error);
  }

  get settled(): boolean {
    return this.#settled;
  }
}

export type TurnSettleBehavior = "auto" | "manual";

/**
 * Events the agent runner reacts to. Emitted through the real subscription the
 * runner registers, so subscription/teardown behavior is exercised honestly.
 */
export type HarnessSessionEvent =
  | { type: "message_update"; assistantMessageEvent: { type: "text_delta"; delta: string } | { type: string } }
  | { type: "turn_end" }
  | { type: "tool_execution_end" }
  | { type: "message_end" }
  | { type: "compaction_end" }
  | (Record<string, unknown> & { type: string });

export interface ScriptedAgentSessionOptions {
  stats?: SessionStats;
  contextUsage?: ContextUsage;
  /** Default settlement behavior for steer() calls. */
  steerSettleBehavior?: TurnSettleBehavior;
  /** Default settlement behavior for abort() calls. */
  abortSettleBehavior?: TurnSettleBehavior;
}

/**
 * Scripted fake AgentRunnerSession. Turn completion is deferred; prompt entry,
 * steering, aborts, unsubscribe, and disposal are recorded.
 */
export class ScriptedAgentSession implements AgentRunnerSession {
  /** Prompt texts in the order they were received (1-based turn number = index + 1). */
  readonly prompts: string[] = [];
  readonly steerCalls: Array<{ text: string; settled: SettledCall }> = [];
  readonly abortCalls: SettledCall[] = [];
  unsubscribeCalls = 0;
  disposeCalls = 0;
  /** Mutable context usage surfaced via getContextUsage(); the runner re-reads it on each event. */
  contextUsage: ContextUsage | undefined;
  /** Fixed stats returned by getSessionStats(). */
  stats: SessionStats;
  steerSettleBehavior: TurnSettleBehavior;
  abortSettleBehavior: TurnSettleBehavior;

  #listener: AgentSessionEventListener | undefined;
  #tools: any[] = [];
  #turnCompletions: (Deferred<void> | undefined)[] = [];
  #turnEnterWaits: Array<{ turn: number; resolve: (text: string) => void }> = [];

  constructor(options: ScriptedAgentSessionOptions = {}) {
    this.stats = options.stats ?? makeSessionStats();
    this.contextUsage = options.contextUsage;
    this.steerSettleBehavior = options.steerSettleBehavior ?? "auto";
    this.abortSettleBehavior = options.abortSettleBehavior ?? "auto";
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.#listener = listener;
    return () => {
      this.unsubscribeCalls += 1;
      if (this.#listener === listener) this.#listener = undefined;
    };
  }

  prompt(text: string): Promise<void> {
    const index = this.prompts.length;
    this.prompts.push(text);
    const completion = deferred<void>();
    this.#turnCompletions[index] = completion;
    const waiters = this.#turnEnterWaits.filter((wait) => wait.turn === index + 1);
    this.#turnEnterWaits = this.#turnEnterWaits.filter((wait) => wait.turn !== index + 1);
    for (const wait of waiters) wait.resolve(text);
    return completion.promise;
  }

  steer(text: string): Promise<void> {
    const settled = new SettledCall();
    this.steerCalls.push({ text, settled });
    if (this.steerSettleBehavior === "auto") settled.resolve();
    return settled.promise;
  }

  abort(): Promise<void> {
    const settled = new SettledCall();
    this.abortCalls.push(settled);
    if (this.abortSettleBehavior === "auto") settled.resolve();
    return settled.promise;
  }

  dispose(): void {
    this.disposeCalls += 1;
  }

  getSessionStats(): SessionStats {
    return this.stats;
  }

  getContextUsage(): ContextUsage | undefined {
    return this.contextUsage;
  }

  // --- test control surface -------------------------------------------------

  /** Barrier: resolves with the prompt text as soon as the n-th (1-based) turn has been entered. */
  promptEntered(n: number): Promise<string> {
    const index = n - 1;
    if (this.prompts.length > index) return Promise.resolve(this.prompts[index]);
    return new Promise<string>((resolve) => this.#turnEnterWaits.push({ turn: n, resolve }));
  }

  /** Complete the n-th (1-based) deferred turn. */
  resolveTurn(n: number): void {
    this.#completionFor(n).resolve();
  }

  /** Fail the n-th (1-based) deferred turn. */
  rejectTurn(n: number, error?: unknown): void {
    this.#completionFor(n).reject(error);
  }

  /** Resolves when the n-th (1-based) deferred turn has completed. */
  turnFinished(n: number): Promise<void> {
    return this.#completionFor(n).promise;
  }

  /** Manually settle a previously recorded (1-based) steer call. */
  resolveSteerCall(n: number): void {
    this.#callFor(this.steerCalls, n, "steer").settled.resolve();
  }

  /** Reject a previously recorded (1-based) steer call (e.g. to simulate checkpoint steering failure). */
  rejectSteerCall(n: number, error?: unknown): void {
    this.#callFor(this.steerCalls, n, "steer").settled.reject(error);
  }

  /** Manually settle a previously recorded (1-based) abort call. */
  resolveAbortCall(n: number): void {
    this.#callFor(this.abortCalls, n, "abort").resolve();
  }

  /** Emit a session event through the runner's live subscription. */
  emit(event: HarnessSessionEvent): void {
    if (!this.#listener) {
      throw new Error("harness: no session listener registered; subscribe via runAgent first");
    }
    this.#listener(event as unknown as AgentSessionEvent);
  }

  registerTools(tools: any[]): void {
    this.#tools = tools;
  }

  get registeredToolNames(): string[] {
    return this.#tools.map((tool: any) => (tool && typeof tool.name === "string" ? tool.name : "<unnamed>"));
  }

  /**
   * Execute a tool registered on the factory request with the real closure.
   * Fails immediately for unknown tool names.
   */
  async callTool(name: string, params: unknown): Promise<unknown> {
    const tool = this.#tools.find((t: any) => t && t.name === name);
    if (!tool) {
      throw new Error(
        `harness: unknown tool "${name}" (registered: ${this.registeredToolNames.join(", ") || "none"})`,
      );
    }
    return tool.execute("harness-tool-call", params);
  }

  /** Invoke the real submit_result closure with its real parameter envelope. */
  submitResult(result: unknown): Promise<unknown> {
    return this.callTool("submit_result", { result });
  }

  /** Invoke the real submit_checkpoint closure with its real parameter envelope. */
  submitCheckpoint(checkpoint: unknown): Promise<unknown> {
    return this.callTool("submit_checkpoint", { checkpoint });
  }

  #completionFor(n: number): Deferred<void> {
    const index = n - 1;
    const completion = this.#turnCompletions[index];
    if (!completion) throw new Error(`harness: turn ${n} has not been entered yet`);
    return completion;
  }

  #callFor<T>(calls: T[], n: number, kind: string): T {
    const call = calls[n - 1];
    if (!call) throw new Error(`harness: no recorded ${kind} call ${n}`);
    return call;
  }
}

export interface AgentRunnerHarness {
  /** The single scripted session this harness injects. */
  session: ScriptedAgentSession;
  /** Inject this as `sessionFactory` on RunAgentOptions. */
  sessionFactory: AgentSessionFactory;
  /** Every factory request received, in order. */
  requests: AgentSessionFactoryRequest[];
}

/**
 * Create a fresh harness: one scripted session plus a recording factory.
 * Create one per test; the same session is reused across recovery prompts,
 * matching the runner's same-session recovery behavior.
 */
export function createAgentRunnerHarness(): AgentRunnerHarness {
  const session = new ScriptedAgentSession();
  const requests: AgentSessionFactoryRequest[] = [];
  const sessionFactory: AgentSessionFactory = (request) => {
    requests.push(request);
    session.registerTools(request.customTools);
    return session;
  };
  return { session, sessionFactory, requests };
}

/** Harness pre-seeded with a fake model, plus the matching ModelRef and ModelRuntime. */
export function createModelHarness(
  modelOverrides: Partial<ResolvedAgentModel> = {},
): {
  harness: AgentRunnerHarness;
  model: ResolvedAgentModel;
  modelRef: ModelRef;
  modelRuntime: ModelRuntime;
} {
  const model = makeFakeModel(modelOverrides);
  return {
    harness: createAgentRunnerHarness(),
    model,
    modelRef: makeModelRef(model),
    modelRuntime: makeFakeModelRuntime(model),
  };
}

// --- typed fixtures -----------------------------------------------------------

export function makeSessionStats(
  overrides: Partial<Omit<SessionStats, "tokens">> & { tokens?: Partial<SessionStats["tokens"]> } = {},
): SessionStats {
  const stats: SessionStats = {
    sessionFile: undefined,
    sessionId: "fixture-session",
    userMessages: 1,
    assistantMessages: 2,
    toolCalls: 1,
    toolResults: 1,
    totalMessages: 4,
    tokens: { input: 1_000, output: 500, cacheRead: 250, cacheWrite: 50, total: 1_800 },
    cost: 0.0123,
    contextUsage: undefined,
  };
  if (overrides.tokens) Object.assign(stats.tokens, overrides.tokens);
  const { tokens: _tokens, ...rest } = overrides;
  return Object.assign(stats, rest);
}

export function makeFakeModel(overrides: Partial<ResolvedAgentModel> = {}): ResolvedAgentModel {
  return {
    id: "fake-model",
    name: "Fake Model",
    api: "openai-completions",
    provider: "fake-provider",
    baseUrl: "https://fake.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    contextWindow: 100_000,
    maxTokens: 8_192,
    ...overrides,
  } as ResolvedAgentModel;
}

/**
 * Minimal ModelRuntime adapter. The only runtime behavior the agent runner
 * consumes is getModel(); the unavoidable ModelRuntime assertion is localized
 * here.
 */
export function makeFakeModelRuntime(model: ResolvedAgentModel = makeFakeModel()): ModelRuntime {
  return {
    getModel(providerId: string, modelId: string) {
      return providerId === model.provider && modelId === model.id ? model : undefined;
    },
  } as unknown as ModelRuntime;
}

export function makeModelRef(model: ResolvedAgentModel = makeFakeModel()): ModelRef {
  return { provider: model.provider, model: model.id, thinking: "off" };
}

export function makeContextBudget(overrides: Partial<ContextBudgetConfig> = {}): ContextBudgetConfig {
  return {
    enabled: true,
    warningTokens: 40_000,
    checkpointTokens: 60_000,
    hardLimitTokens: 80_000,
    maxCheckpointsPerStage: 2,
    ...overrides,
  };
}

export function makeDisabledContextBudget(overrides: Partial<ContextBudgetConfig> = {}): ContextBudgetConfig {
  return makeContextBudget({ enabled: false, ...overrides });
}

export function makeContextUsage(tokens: number | null, contextWindow = 100_000): ContextUsage {
  return {
    tokens,
    contextWindow,
    percent: tokens == null ? null : (tokens / contextWindow) * 100,
  };
}

export function makeScoutResultFixture(overrides: Partial<ScoutResult> = {}): ScoutResult {
  return {
    summary: "Fixture scout summary",
    files: [{ path: "src/example.ts", relevance: "fixture relevance" }],
    symbols: [{ name: "exampleSymbol", path: "src/example.ts", relevance: "fixture relevance" }],
    relationships: ["src/example.ts is referenced by src/other.ts"],
    constraints: ["fixture constraint"],
    tests: ["npm test"],
    unknowns: ["fixture unknown"],
    recommendedReads: ["src/example.ts"],
    ...overrides,
  };
}

export function makeWorkerReportFixture(overrides: Partial<WorkerReport> = {}): WorkerReport {
  return {
    unitId: "fixture-unit",
    summary: "Fixture worker report summary",
    changedFiles: ["src/example.ts"],
    testsRun: [{ command: "npm test", result: "pass" }],
    decisions: ["fixture decision"],
    blockers: [],
    remainingWork: [],
    notes: ["fixture note"],
    ...overrides,
  };
}

export function makeCheckpointFixture(overrides: Partial<WorkerCheckpoint> = {}): WorkerCheckpoint {
  return {
    unitId: "fixture-unit",
    summary: "Fixture checkpoint summary",
    completedWork: ["fixture completed work"],
    changedFiles: ["src/example.ts"],
    decisions: ["fixture decision"],
    verifiedFacts: ["fixture verified fact"],
    remainingWork: ["fixture remaining work"],
    blockers: [],
    relevantSymbols: ["exampleSymbol"],
    nextAction: "fixture next action",
    ...overrides,
  };
}
