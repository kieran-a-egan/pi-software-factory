import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { FactoryConfig } from "./types.js";

export const DEFAULT_CONFIG: FactoryConfig = {
  qwen: {
    provider: "unsloth-local",
    model: "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M",
    thinking: "medium",
  },
  astra: {
    provider: "openai-codex",
    model: "gpt-6-astra",
    thinking: "high",
  },
  jev: {
    model: "jev-latest",
    minChoiceConfidence: 0.60,
    minNoulProbability: 0.65,
  },
  contextBudget: {
    enabled: true,
    warningTokens: 65_000,
    checkpointTokens: 75_000,
    hardLimitTokens: 88_000,
    maxCheckpointsPerStage: 3,
  },
  planningLoops: {
    maxRescoutPasses: 2,
    maxReplanPasses: 2,
  },
  runRoot: ".pi/software-factory/runs",
  contextPaths: ["AGENTS.md", ".okf/project"],
  contextMaxBytes: 180_000,
  requireCleanWorkingTree: true,
  verificationCommands: [],
  maxRepairPasses: 1,
  workerMaxRuntimeMinutes: 20,
  maxDiffCharsForReview: 120_000,
};

function deepMerge<T extends Record<string, any>>(base: T, override: Partial<T>): T {
  const out: Record<string, any> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value) && typeof out[key] === "object") {
      out[key] = deepMerge(out[key], value as Record<string, any>);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}

export function loadConfig(cwd: string): FactoryConfig {
  const configPath = join(cwd, ".pi", "software-factory.json");
  if (!existsSync(configPath)) return structuredClone(DEFAULT_CONFIG);

  const parsed = JSON.parse(readFileSync(configPath, "utf8"));
  const config = deepMerge(structuredClone(DEFAULT_CONFIG), parsed);

  // v0.3 and earlier recommended .okf/work even though run artifacts are ordinary
  // JSON/JSONL rather than OKF documents. Treat that exact legacy default as a
  // migration alias without moving or deleting historical runs.
  if (parsed.runRoot === ".okf/work") {
    config.runRoot = DEFAULT_CONFIG.runRoot;
  }

  const budget = config.contextBudget;
  if (
    !Number.isSafeInteger(budget.warningTokens) ||
    !Number.isSafeInteger(budget.checkpointTokens) ||
    !Number.isSafeInteger(budget.hardLimitTokens) ||
    budget.warningTokens <= 0 ||
    budget.warningTokens >= budget.checkpointTokens ||
    budget.checkpointTokens >= budget.hardLimitTokens
  ) {
    throw new Error(
      "Invalid contextBudget: require 0 < warningTokens < checkpointTokens < hardLimitTokens.",
    );
  }
  if (!Number.isSafeInteger(budget.maxCheckpointsPerStage) || budget.maxCheckpointsPerStage < 0) {
    throw new Error("Invalid contextBudget.maxCheckpointsPerStage: expected a non-negative integer.");
  }

  const planning = config.planningLoops;
  if (!Number.isSafeInteger(planning.maxRescoutPasses) || planning.maxRescoutPasses < 0) {
    throw new Error("Invalid planningLoops.maxRescoutPasses: expected a non-negative integer.");
  }
  if (!Number.isSafeInteger(planning.maxReplanPasses) || planning.maxReplanPasses < 0) {
    throw new Error("Invalid planningLoops.maxReplanPasses: expected a non-negative integer.");
  }

  if (!Number.isFinite(config.workerMaxRuntimeMinutes) || config.workerMaxRuntimeMinutes <= 0) {
    throw new Error("Invalid workerMaxRuntimeMinutes: expected a positive number.");
  }

  if (!isAbsolute(config.runRoot)) config.runRoot = join(cwd, config.runRoot);
  return config;
}

export function resolveRunRoot(cwd: string, config: FactoryConfig): string {
  return isAbsolute(config.runRoot) ? config.runRoot : join(cwd, config.runRoot);
}
