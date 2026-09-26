/**
 * Test-only scripted harness for exercising src/agent-runner.ts without any
 * SDK session construction, model calls, network access, or repository tools.
 *
 * The harness implements the runner's structural `AgentRunnerSession` seam and
 * records every factory request and session method call.
 *
 * Scripted turns are bounded: the constructor requires the expected-turn bound
 * declared by the scenario. The bound is a maximum — permitting N turns does not
 * assert that all N turns occur; tests keep explicit assertions on the actual
 * prompt count. A prompt beyond the bound fails immediately with a diagnostic
 * and never allocates a pending turn.
 *
 * Run settlement is observed explicitly: `trackRun()` attaches both
 * fulfillment and rejection handlers to the run promise the moment the run
 * starts, recording the outcome in a pending/fulfilled/rejected discriminated
 * observer. Prompt-entry barriers (`promptEntered`) terminate diagnostically if
 * the observed run settles before the requested entry instead of hanging.
 *
 * `cleanup()` is idempotent and failure-safe: it first enters a terminal
 * cleanup mode, then settles every entered pending turn and every recorded
 * pending steer/abort call, keeps any prompt arriving during cleanup from
 * becoming pending work, and finally awaits the observed run outcome. Cleanup
 * handles run settlement (deadline, external abort, result) and prompt
 * settlement independently — it never manufactures submissions and does not
 * change normal cooperative cancellation semantics.
 *
 * Events flow through the real subscription the runner registers, using the
 * real SDK `AgentSessionEvent` type; fixtures are structurally checked.
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

/** A single entered turn: its completion deferred plus a synchronous settlement flag. */
interface TurnGate {
  completion: Deferred<void>;
  settled: boolean;
}

export type TurnSettleBehavior = "auto" | "manual";

export type RunOutcomeState = "pending" | "fulfilled" | "rejected";

/**
 * Discriminated settlement record for a run outcome. The observer promise
 * always fulfills with one of these shapes, so consuming the outcome never
 * requires a `catch` wrapper: a rejected run is data (`state: "rejected"`),
 * not a promise rejection.
 */
export type RunResult<T> =
  | { state: "fulfilled"; value: T }
  | { state: "rejected"; error: unknown };

/**
 * Immediately observed, non-rejecting run-outcome observer. The tracked run's
 * fulfillment and rejection handlers are attached at `trackRun` time, so a
 * rejected run can never surface as an unhandled rejection. The observer
 * promise always fulfills with a discriminated `RunResult`; `state`,
 * `settled`, `value`, and `rejection` expose the same facts synchronously for
 * lifecycle assertions.
 */
export class RunOutcome<T = unknown> {
  readonly promise: Promise<RunResult<T>>;
  #state: RunOutcomeState = "pending";
  #value: T;
  #error: unknown;
  #resolve!: (result: RunResult<T>) => void;

  constructor() {
    this.#value = undefined as T;
    this.#error = undefined;
    this.promise = new Promise<RunResult<T>>((resolve) => {
      this.#resolve = resolve;
    });
  }

  fulfill(value: T): void {
    if (this.#state !== "pending") return;
    this.#state = "fulfilled";
    this.#value = value;
    this.#resolve({ state: "fulfilled", value });
  }

  reject(error?: unknown): void {
    if (this.#state !== "pending") return;
    this.#state = "rejected";
    this.#error = error ?? new Error("harness: run rejected without an error value");
    this.#resolve({ state: "rejected", error: this.#error });
  }

  get state(): RunOutcomeState {
    return this.#state;
  }

  get settled(): boolean {
    return this.#state !== "pending";
  }

  get value(): T {
    if (this.#state !== "fulfilled") {
      throw new Error(`harness: run outcome is ${this.#state}, not fulfilled`);
    }
    return this.#value;
  }

  get rejection(): unknown {
    if (this.#state !== "rejected") {
      throw new Error(`harness: run outcome is ${this.#state}, not rejected`);
    }
    return this.#error;
  }
}

/**
 * Narrow, documented callable contract for the runner's custom submission
 * tools (`submit_result`, `submit_checkpoint`) as registered on
 * `AgentSessionFactoryRequest.customTools`.
 *
 * The production request keeps its `any[]` API unchanged; the harness stores
 * and invokes these closures through this boundary instead of `any` arrays.
 * The runner's real closures accept two positional arguments — `(toolCallId,
 * params)` — and that is the only surface the test seam consumes. This is not
 * an attempt to construct an SDK ExtensionContext or assert an incomplete SDK
 * tool object; the SDK's optional `signal`/`onUpdate` arguments are
 * deliberately out of the contract.
 */
export interface HarnessSubmissionTool {
  readonly name: string;
  execute(toolCallId: string, params: unknown): Promise<unknown>;
}

export interface ScriptedAgentSessionOptions {
  stats?: SessionStats;
  contextUsage?: ContextUsage;
  /** Default settlement behavior for steer() calls. */
  steerSettleBehavior?: TurnSettleBehavior;
  /** Default settlement behavior for abort() calls. */
  abortSettleBehavior?: TurnSettleBehavior;
  /**
   * The harness's run-outcome observer. When present, prompt-entry waits
   * terminate diagnostically if the run settles before the requested entry.
   */
  runOutcome?: RunOutcome<unknown>;
}

/**
 * Scripted fake AgentRunnerSession with bounded turns. Turn completion is
 * deferred; prompt entry, steering, aborts, unsubscribe, and disposal are
 * recorded. A prompt beyond the expected-turn bound throws immediately without
 * allocating a pending turn; in terminal cleanup mode prompts are recorded and
 * settled immediately so they can never become pending work.
 */
export class ScriptedAgentSession implements AgentRunnerSession {
  /** Prompt texts in the order they were received (1-based turn number = index + 1). */
  readonly prompts: string[] = [];
  readonly steerCalls: Array<{ text: string; settled: SettledCall }> = [];
  readonly abortCalls: SettledCall[] = [];
  unsubscribeCalls = 0;
  disposeCalls = 0;
  /** Maximum permitted scripted turns for this scenario. */
  readonly expectedTurns: number;
  /** Mutable context usage surfaced via getContextUsage(); the runner re-reads it on each event. */
  contextUsage: ContextUsage | undefined;
  /** Fixed stats returned by getSessionStats(). */
  stats: SessionStats;
  steerSettleBehavior: TurnSettleBehavior;
  abortSettleBehavior: TurnSettleBehavior;

  #listener: AgentSessionEventListener | undefined;
  #tools: HarnessSubmissionTool[] = [];
  #turnGates: (TurnGate | undefined)[] = [];
  #turnEnterWaits: Array<{ turn: number; resolve: (text: string) => void; reject: (error: unknown) => void }> = [];
  #cleanupMode = false;
  #runOutcome: RunOutcome<unknown> | undefined;

  constructor(expectedTurns: number, options: ScriptedAgentSessionOptions = {}) {
    if (!Number.isInteger(expectedTurns) || expectedTurns < 1) {
      throw new Error(`harness: expectedTurns must be a positive integer, got ${String(expectedTurns)}`);
    }
    this.expectedTurns = expectedTurns;
    this.stats = options.stats ?? makeSessionStats();
    this.contextUsage = options.contextUsage;
    this.steerSettleBehavior = options.steerSettleBehavior ?? "auto";
    this.abortSettleBehavior = options.abortSettleBehavior ?? "auto";
    this.#runOutcome = options.runOutcome;
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.#listener = listener;
    return () => {
      this.unsubscribeCalls += 1;
      if (this.#listener === listener) this.#listener = undefined;
    };
  }

  prompt(text: string): Promise<void> {
    // The declared bound is enforced before any cleanup-mode branch: overflow
    // is a scenario bug that must fail immediately even once cleanup has begun,
    // so the observed run outcome captures the overflow rejection rather than
    // silently recording unbounded prompts.
    if (this.prompts.length >= this.expectedTurns) {
      throw new Error(
        `harness: prompt for turn ${this.prompts.length + 1} exceeds the expected-turn bound of ` +
          `${this.expectedTurns}; the scenario must declare that turn at harness construction`,
      );
    }
    // Terminal cleanup mode: record a permitted prompt but never make it
    // pending, so prompts arriving during cleanup cannot leave unresolved work
    // behind.
    if (this.#cleanupMode) {
      this.prompts.push(text);
      this.#resolveEntryWaits(this.prompts.length, text);
      return Promise.resolve();
    }
    const index = this.prompts.length;
    this.prompts.push(text);
    const completion = deferred<void>();
    this.#turnGates[index] = { completion, settled: false };
    this.#resolveEntryWaits(index + 1, text);
    return completion.promise;
  }

  steer(text: string): Promise<void> {
    const settled = new SettledCall();
    this.steerCalls.push({ text, settled });
    // In terminal cleanup mode a continuation may record a fresh manual steer
    // after beginCleanup() has already settled the calls it knew about; settle
    // it immediately so it can never remain pending. Normal-mode behavior is
    // unchanged.
    if (this.steerSettleBehavior === "auto" || this.#cleanupMode) settled.resolve();
    return settled.promise;
  }

  abort(): Promise<void> {
    const settled = new SettledCall();
    this.abortCalls.push(settled);
    if (this.abortSettleBehavior === "auto" || this.#cleanupMode) settled.resolve();
    return settled.promise;
  }

  /** Resolve any prompt-entry barriers waiting on the just-entered turn. */
  #resolveEntryWaits(turn: number, text: string): void {
    const waiters = this.#turnEnterWaits.filter((wait) => wait.turn === turn);
    this.#turnEnterWaits = this.#turnEnterWaits.filter((wait) => wait.turn !== turn);
    for (const wait of waiters) wait.resolve(text);
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

  get cleanupMode(): boolean {
    return this.#cleanupMode;
  }

  /**
   * Enter terminal cleanup mode. Idempotent. Mode is entered first so that a
   * prompt arriving while the pending work is settled cannot become pending,
   * then every entered pending turn and every recorded pending steer/abort call
   * is settled. Settling a turn whose run already settled (e.g. a deadline
   * raced the scripted prompt) is harmless: it never manufactures a
   * submission and changes no normal abort semantics.
   */
  beginCleanup(): void {
    if (this.#cleanupMode) return;
    this.#cleanupMode = true;
    for (const gate of this.#turnGates) {
      if (gate && !gate.settled) {
        gate.settled = true;
        gate.completion.resolve();
      }
    }
    for (const { settled } of this.steerCalls) settled.resolve();
    for (const settled of this.abortCalls) settled.resolve();
  }

  /**
   * Barrier: resolves with the prompt text as soon as the n-th (1-based) turn
   * has been entered. Rejects for invalid turn indices (non-positive or beyond
   * the expected-turn bound) and, when a run-outcome observer is attached,
   * rejects diagnostically if the run settles before the requested entry.
   */
  promptEntered(n: number): Promise<string> {
    const index = n - 1;
    if (!Number.isInteger(n) || n < 1) {
      return Promise.reject(new Error(`harness: invalid turn index ${String(n)}; turns are 1-based`));
    }
    if (n > this.expectedTurns) {
      return Promise.reject(
        new Error(`harness: turn index ${n} exceeds the expected-turn bound of ${this.expectedTurns}`),
      );
    }
    if (this.prompts.length > index) return Promise.resolve(this.prompts[index]);
    const entry = deferred<string>();
    this.#turnEnterWaits.push({ turn: n, resolve: entry.resolve, reject: entry.reject });
    const outcome = this.#runOutcome;
    if (!outcome) return entry.promise;
    if (outcome.settled) {
      return Promise.reject(
        this.#runSettledBeforeEntryError(
          n,
          outcome,
          outcome.state === "rejected" ? outcome.rejection : undefined,
        ),
      );
    }
    // The observer promise always fulfills with a discriminated outcome; a
    // settled run (fulfilled or rejected) before entry rejects the barrier.
    void outcome.promise.then((result) =>
      entry.reject(
        this.#runSettledBeforeEntryError(
          n,
          outcome,
          result.state === "rejected" ? result.error : undefined,
        ),
      ),
    );
    return entry.promise;
  }

  /** Complete the n-th (1-based) deferred turn. */
  resolveTurn(n: number): void {
    const gate = this.#gateFor(n);
    if (!gate.settled) {
      gate.settled = true;
      gate.completion.resolve();
    }
  }

  /** Fail the n-th (1-based) deferred turn. */
  rejectTurn(n: number, error?: unknown): void {
    const gate = this.#gateFor(n);
    if (!gate.settled) {
      gate.settled = true;
      gate.completion.reject(error);
    }
  }

  /** Resolves when the n-th (1-based) deferred turn has completed. */
  turnFinished(n: number): Promise<void> {
    return this.#gateFor(n).completion.promise;
  }

  /** Synchronously reports whether the n-th (1-based) turn has settled. */
  turnSettled(n: number): boolean {
    return this.#gateFor(n).settled;
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
  emit(event: AgentSessionEvent): void {
    if (!this.#listener) {
      throw new Error("harness: no session listener registered; subscribe via runAgent first");
    }
    this.#listener(event);
  }

  /**
   * Record the runner's custom submission tools through the typed harness
   * boundary. The production `customTools` request field stays `any[]`;
   * assigning it here is the single, documented seam crossing.
   */
  registerTools(tools: HarnessSubmissionTool[]): void {
    this.#tools = tools;
  }

  get registeredToolNames(): string[] {
    return this.#tools.map((tool) => tool.name);
  }

  /**
   * Execute a registered submission tool with its real two-argument closure.
   * Fails immediately for unknown tool names.
   */
  async callTool(name: string, params: unknown): Promise<unknown> {
    const tool = this.#tools.find((t) => t.name === name);
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

  #gateFor(n: number): TurnGate {
    const index = n - 1;
    const gate = this.#turnGates[index];
    if (!gate) throw new Error(`harness: turn ${n} has not been entered yet`);
    return gate;
  }

  #callFor<T>(calls: T[], n: number, kind: string): T {
    const call = calls[n - 1];
    if (!call) throw new Error(`harness: no recorded ${kind} call ${n}`);
    return call;
  }

  #runSettledBeforeEntryError(n: number, outcome: RunOutcome<unknown>, rejection?: unknown): Error {
    const detail =
      outcome.state === "rejected"
        ? ` (rejected: ${String(rejection ?? outcome.rejection)})`
        : " (fulfilled)";
    return new Error(`harness: run settled before turn ${n} was entered${detail}`);
  }
}

export interface AgentRunnerHarness {
  /** The single scripted session this harness injects. */
  session: ScriptedAgentSession;
  /** Inject this as `sessionFactory` on RunAgentOptions. */
  sessionFactory: AgentSessionFactory;
  /** Every factory request received, in order. */
  requests: AgentSessionFactoryRequest[];
  /**
   * Run-outcome observer for the run this harness drives. Both settlement
   * handlers are attached at construction; `state` discriminates
   * pending/fulfilled/rejected for lifecycle assertions.
   */
  runOutcome: RunOutcome<unknown>;
  /**
   * Attach the run promise for observation. Call synchronously at run start,
   * before awaiting it, and at most once per harness.
   */
  trackRun(run: Promise<unknown>): void;
  /** True once `cleanup()` has entered terminal cleanup mode. */
  readonly cleaningUp: boolean;
  /**
   * Idempotent, failure-safe cleanup. Enters terminal cleanup mode first,
   * settles every entered pending turn and every recorded pending steer/abort
   * call (including a scripted turn left pending after the runner timed out),
   * keeps prompts arriving during cleanup from becoming pending, and awaits
   * the observed run outcome without rethrowing its rejection. Call
   * unconditionally (e.g. in `finally`) after starting the run; repeated calls
   * have no further effect.
   */
  cleanup(): Promise<void>;
}

/**
 * Create a fresh harness: one bounded scripted session plus a recording
 * factory. The scenario-declared `expectedTurns` bound is required — it is the
 * maximum number of prompts the runner may be allowed to issue. Create one
 * harness per test and per run; the same session is reused across recovery
 * prompts, matching the runner's same-session recovery behavior.
 */
export function createAgentRunnerHarness(
  expectedTurns: number,
  options: ScriptedAgentSessionOptions = {},
): AgentRunnerHarness {
  const runOutcome = new RunOutcome<unknown>();
  const session = new ScriptedAgentSession(expectedTurns, { ...options, runOutcome });
  const requests: AgentSessionFactoryRequest[] = [];
  let tracked = false;
  const sessionFactory: AgentSessionFactory = (request) => {
    requests.push(request);
    session.registerTools(request.customTools);
    return session;
  };
  return {
    session,
    sessionFactory,
    requests,
    runOutcome,
    trackRun(run: Promise<unknown>): void {
      if (tracked) {
        throw new Error("harness: a run is already tracked; create one harness per run");
      }
      tracked = true;
      // Attach both settlement handlers immediately so the outcome can never
      // escape as an unhandled rejection, tracked or not.
      void run.then(
        (value) => runOutcome.fulfill(value),
        (error: unknown) => runOutcome.reject(error),
      );
    },
    get cleaningUp(): boolean {
      return session.cleanupMode;
    },
    async cleanup(): Promise<void> {
      session.beginCleanup();
      if (!tracked) return;
      // The observer promise always fulfills with a discriminated outcome, so
      // awaiting it observes run settlement without rethrowing a rejection.
      await runOutcome.promise;
    },
  };
}

/** Harness pre-seeded with a fake model, plus the matching ModelRef and ModelRuntime. */
export function createModelHarness(
  expectedTurns: number,
  modelOverrides: Partial<ResolvedAgentModel> = {},
): {
  harness: AgentRunnerHarness;
  model: ResolvedAgentModel;
  modelRef: ModelRef;
  modelRuntime: ModelRuntime;
} {
  const model = makeFakeModel(modelOverrides);
  return {
    harness: createAgentRunnerHarness(expectedTurns),
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

/** A minimal structurally valid `AgentMessage` for turn/message event fixtures. */
function makeFixtureMessage(): Extract<AgentSessionEvent, { type: "turn_end" }>["message"] {
  return { role: "user", content: "Fixture turn message", timestamp: 0 };
}

/** Minimal structurally complete `turn_end` AgentSessionEvent fixture. */
export function makeTurnEndEvent(): AgentSessionEvent {
  return {
    type: "turn_end",
    message: makeFixtureMessage(),
    toolResults: [],
  };
}

/** Minimal structurally complete `tool_execution_end` AgentSessionEvent fixture. */
export function makeToolExecutionEndEvent(
  overrides: Partial<Omit<Extract<AgentSessionEvent, { type: "tool_execution_end" }>, "type">> = {},
): AgentSessionEvent {
  return {
    type: "tool_execution_end",
    toolCallId: "fixture-tool-call",
    toolName: "submit_result",
    result: { content: [{ type: "text", text: "Fixture tool result" }], details: {} },
    isError: false,
    ...overrides,
  };
}

/**
 * Structurally checked fake model. Every required `Model` field is present and
 * typed; no assertion is needed to build it.
 */
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
  };
}

/**
 * Minimal ModelRuntime adapter. The only runtime behavior the agent runner
 * consumes is getModel(); its implementation below is structurally checked
 * against the SDK method signature, and the single unavoidable assertion is
 * localized to the return statement.
 */
export function makeFakeModelRuntime(model: ResolvedAgentModel = makeFakeModel()): ModelRuntime {
  const getModel: ModelRuntime["getModel"] = (providerId: string, modelId: string) =>
    providerId === model.provider && modelId === model.id ? model : undefined;
  return { getModel } as unknown as ModelRuntime;
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
