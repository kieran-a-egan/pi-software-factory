export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelRef {
  provider: string;
  model: string;
  thinking: ThinkingLevel;
}

export interface TokenUsageSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface ContextUsageSnapshot {
  tokens: number;
  contextWindow?: number;
  percent?: number | null;
}

export interface ContextBudgetConfig {
  enabled: boolean;
  warningTokens: number;
  checkpointTokens: number;
  hardLimitTokens: number;
  maxCheckpointsPerStage: number;
}

export interface PlanningLoopConfig {
  maxRescoutPasses: number;
  maxReplanPasses: number;
}

export interface WorkerCheckpoint {
  unitId: string;
  summary: string;
  completedWork: string[];
  changedFiles: string[];
  decisions: string[];
  verifiedFacts: string[];
  remainingWork: string[];
  blockers: string[];
  relevantSymbols: string[];
  nextAction: string;
}

export interface ContextCheckpointRecord {
  stage: string;
  label?: string;
  index: number;
  createdAt: string;
  context: ContextUsageSnapshot;
  checkpoint: WorkerCheckpoint;
}

export interface StageTelemetry {
  stage: string;
  label?: string;
  actor: "controller" | "jev" | "qwen" | "astra" | "tools";
  model?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  outcome: "completed" | "failed";
  tokens?: TokenUsageSnapshot;
  cost?: number;
  contextUsage?: unknown;
  maxContextTokens?: number;
  contextWindow?: number;
  compactions?: number;
  checkpointRequested?: boolean;
  error?: string;
}

export type FactoryProgressEvent =
  | { type: "started"; stage: string; label?: string; actor: StageTelemetry["actor"]; model?: string }
  | { type: "completed"; telemetry: StageTelemetry }
  | {
      type: "context";
      stage: string;
      label?: string;
      level: "warning" | "checkpoint";
      usage: ContextUsageSnapshot;
    }
  | {
      type: "checkpoint-saved";
      stage: string;
      label?: string;
      index: number;
      usage: ContextUsageSnapshot;
    };

export interface FactoryConfig {
  qwen: ModelRef;
  astra: ModelRef;
  jev: {
    model: string;
    minChoiceConfidence: number;
    minNoulProbability: number;
  };
  contextBudget: ContextBudgetConfig;
  planningLoops: PlanningLoopConfig;
  runRoot: string;
  contextPaths: string[];
  contextMaxBytes: number;
  requireCleanWorkingTree: boolean;
  verificationCommands: string[];
  maxRepairPasses: number;
  maxDiffCharsForReview: number;
}

export interface IntakeDecision {
  taskType: "feature" | "bug" | "refactor" | "docs" | "test" | "ops" | "unknown";
  requirementClarity: "clear" | "minor_gaps" | "major_gaps";
  statedRisk: "low" | "medium" | "high" | "critical";
  confidence: Record<string, number>;
  raw: unknown;
}

export interface ScoutResult {
  summary: string;
  files: Array<{ path: string; relevance: string }>;
  symbols: Array<{ name: string; path: string; relevance: string }>;
  relationships: string[];
  constraints: string[];
  tests: string[];
  unknowns: string[];
  recommendedReads: string[];
}

export interface ImplementationUnit {
  id: string;
  objective: string;
  rationale?: string;
  filesExpected?: string[];
  acceptance: string[];
  constraints: string[];
  dependsOn?: string[];
}

export interface ArchitectureResult {
  summary: string;
  approach: string;
  architecturalDecisions: string[];
  risks: string[];
  implementationUnits: ImplementationUnit[];
  verificationStrategy: string[];
  assumptions: string[];
}

export interface PlanGateDecision {
  action: "proceed" | "rescout" | "replan" | "human";
  implementationRisk: "low" | "medium" | "high" | "critical";
  planCompleteProbability: number;
  rescoutFocus: "none" | "dependencies" | "tests" | "data_model" | "interfaces" | "runtime_config" | "security" | "other";
  replanFocus: "none" | "scope" | "sequencing" | "architecture" | "verification" | "risk_controls" | "assumptions" | "other";
  confidence: number;
  raw: unknown;
}

/**
 * Facts reported by a Qwen implementation/repair worker.
 * Deliberately contains no success/completion verdict: Jev owns that semantic decision.
 */
export interface WorkerReport {
  unitId: string;
  summary: string;
  changedFiles: string[];
  testsRun: Array<{ command: string; result: string }>;
  decisions: string[];
  blockers: string[];
  remainingWork: string[];
  notes: string[];
}

export interface WorkerGateDecision {
  disposition: "ready" | "continue" | "blocked" | "invalid";
  confidence: number;
  raw: unknown;
}

export interface VerificationResult {
  passed: boolean;
  checks: Array<{
    command: string;
    passed: boolean;
    exitCode: number | null;
    output: string;
  }>;
  gitStatus: string;
  diffStat: string;
  diff: string;
}

export interface ReviewFinding {
  severity: "info" | "minor" | "major" | "critical";
  title: string;
  explanation: string;
  file?: string;
  line?: number;
  suggestedFix?: string;
}

export interface ReviewResult {
  summary: string;
  verdict: "clean" | "changes_requested" | "architectural_issue" | "uncertain";
  findings: ReviewFinding[];
  requirementCoverage: string[];
  testGaps: string[];
}

export interface ReviewGateDecision {
  action: "accept" | "rework" | "replan" | "human";
  residualRisk: "low" | "medium" | "high" | "critical";
  reviewSufficientProbability: number;
  confidence: number;
  raw: unknown;
}

export interface FactoryRunState {
  id: string;
  createdAt: string;
  cwd: string;
  objective: string;
  phase: string;
  intake?: IntakeDecision;
  scout?: ScoutResult;
  architecture?: ArchitectureResult;
  planGate?: PlanGateDecision;
  workers?: WorkerReport[];
  workerGates?: WorkerGateDecision[];
  checkpoints?: ContextCheckpointRecord[];
  verification?: VerificationResult;
  review?: ReviewResult;
  reviewGate?: ReviewGateDecision;
  repairPasses: number;
  rescoutPasses: number;
  replanPasses: number;
  planGatePasses: number;
  telemetry?: StageTelemetry[];
  finalStatus?: "accepted" | "human" | "failed" | "blocked";
  finalReason?: string;
}
