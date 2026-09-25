import type {
  ArchitectureResult,
  ReviewResult,
  ScoutResult,
  WorkerCheckpoint,
  WorkerReport,
} from "./types.js";

function obj(value: unknown, name: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, any>;
}

function structuredObj(value: unknown, name: string): Record<string, any> {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        value = JSON.parse(trimmed);
      } catch {
        throw new Error(`${name} must be an object; received invalid JSON text`);
      }
    }
  }
  return obj(value, name);
}

function str(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function arr(value: unknown, name: string): any[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

export function validateScout(value: unknown): ScoutResult {
  const v = obj(value, "ScoutResult");
  return {
    summary: str(v.summary, "summary"),
    files: arr(v.files, "files").map((x, i) => {
      const y = obj(x, `files[${i}]`);
      return { path: str(y.path, "path"), relevance: str(y.relevance, "relevance") };
    }),
    symbols: arr(v.symbols, "symbols").map((x, i) => {
      const y = obj(x, `symbols[${i}]`);
      return { name: str(y.name, "name"), path: str(y.path, "path"), relevance: str(y.relevance, "relevance") };
    }),
    relationships: arr(v.relationships, "relationships").map(String),
    constraints: arr(v.constraints, "constraints").map(String),
    tests: arr(v.tests, "tests").map(String),
    unknowns: arr(v.unknowns, "unknowns").map(String),
    recommendedReads: arr(v.recommendedReads, "recommendedReads").map(String),
  };
}

export function validateArchitecture(value: unknown): ArchitectureResult {
  const v = obj(value, "ArchitectureResult");
  const units = arr(v.implementationUnits, "implementationUnits").map((x, i) => {
    const y = obj(x, `implementationUnits[${i}]`);
    return {
      id: str(y.id, "id"),
      objective: str(y.objective, "objective"),
      rationale: y.rationale == null ? undefined : str(y.rationale, "rationale"),
      filesExpected: y.filesExpected == null ? undefined : arr(y.filesExpected, "filesExpected").map(String),
      acceptance: arr(y.acceptance, "acceptance").map(String),
      constraints: arr(y.constraints, "constraints").map(String),
      dependsOn: y.dependsOn == null ? undefined : arr(y.dependsOn, "dependsOn").map(String),
    };
  });
  if (units.length === 0) throw new Error("implementationUnits must contain at least one unit");

  return {
    summary: str(v.summary, "summary"),
    approach: str(v.approach, "approach"),
    architecturalDecisions: arr(v.architecturalDecisions, "architecturalDecisions").map(String),
    risks: arr(v.risks, "risks").map(String),
    implementationUnits: units,
    verificationStrategy: arr(v.verificationStrategy, "verificationStrategy").map(String),
    assumptions: arr(v.assumptions, "assumptions").map(String),
  };
}

/** Structural validation only. Semantic completion/blocking is classified by Jev. */
export function validateWorkerReport(value: unknown): WorkerReport {
  const v = structuredObj(value, "WorkerReport");

  // Worker reports contain evidence, not verdicts. Ignore any legacy/model-added
  // `status` field rather than interpreting it. `unresolved` is accepted as a
  // backwards-compatible evidence alias for remainingWork during the v0.1.x migration.
  const changedFiles = v.changedFiles == null ? [] : arr(v.changedFiles, "changedFiles").map(String);
  const tests = v.testsRun == null ? [] : arr(v.testsRun, "testsRun");
  const decisions = v.decisions == null ? [] : arr(v.decisions, "decisions").map(String);
  const blockers = v.blockers == null ? [] : arr(v.blockers, "blockers").map(String);
  const remainingSource = v.remainingWork ?? v.unresolved ?? [];
  const remainingWork = arr(remainingSource, "remainingWork").map(String);
  const notes = v.notes == null ? [] : arr(v.notes, "notes").map(String);

  return {
    unitId: str(v.unitId, "unitId"),
    summary: str(v.summary, "summary"),
    changedFiles,
    testsRun: tests.map((x, i) => {
      const y = obj(x, `testsRun[${i}]`);
      return { command: str(y.command, "command"), result: str(y.result, "result") };
    }),
    decisions,
    blockers,
    remainingWork,
    notes,
  };
}


export function validateWorkerCheckpoint(value: unknown): WorkerCheckpoint {
  const v = structuredObj(value, "WorkerCheckpoint");
  return {
    unitId: str(v.unitId, "unitId"),
    summary: str(v.summary, "summary"),
    completedWork: arr(v.completedWork ?? [], "completedWork").map(String),
    changedFiles: arr(v.changedFiles ?? [], "changedFiles").map(String),
    decisions: arr(v.decisions ?? [], "decisions").map(String),
    verifiedFacts: arr(v.verifiedFacts ?? [], "verifiedFacts").map(String),
    remainingWork: arr(v.remainingWork ?? [], "remainingWork").map(String),
    blockers: arr(v.blockers ?? [], "blockers").map(String),
    relevantSymbols: arr(v.relevantSymbols ?? [], "relevantSymbols").map(String),
    nextAction: str(v.nextAction, "nextAction"),
  };
}

export function validateReview(value: unknown): ReviewResult {
  const v = obj(value, "ReviewResult");
  const verdict = str(v.verdict, "verdict") as ReviewResult["verdict"];
  if (!new Set(["clean", "changes_requested", "architectural_issue", "uncertain"]).has(verdict)) {
    throw new Error(`invalid review verdict: ${verdict}`);
  }
  return {
    summary: str(v.summary, "summary"),
    verdict,
    findings: arr(v.findings, "findings").map((x, i) => {
      const y = obj(x, `findings[${i}]`);
      const severity = str(y.severity, "severity") as "info" | "minor" | "major" | "critical";
      if (!new Set(["info", "minor", "major", "critical"]).has(severity)) throw new Error(`invalid finding severity: ${severity}`);
      return {
        severity,
        title: str(y.title, "title"),
        explanation: str(y.explanation, "explanation"),
        file: y.file == null ? undefined : str(y.file, "file"),
        line: typeof y.line === "number" ? y.line : undefined,
        suggestedFix: y.suggestedFix == null ? undefined : str(y.suggestedFix, "suggestedFix"),
      };
    }),
    requirementCoverage: arr(v.requirementCoverage, "requirementCoverage").map(String),
    testGaps: arr(v.testGaps, "testGaps").map(String),
  };
}
