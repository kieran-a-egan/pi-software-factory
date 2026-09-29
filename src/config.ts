import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { FactoryConfig, ThinkingLevel } from "./types.js";

export const MODEL_ROLES = ["scout", "architect", "implementer", "reviewer", "repairer"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const DEFAULT_CONFIG: FactoryConfig = {
  models: {
    scout: {
      provider: "unsloth-local",
      model: "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M",
      thinking: "medium",
    },
    architect: {
      provider: "openai-codex",
      model: "gpt-6-astra",
      thinking: "high",
    },
    implementer: {
      provider: "unsloth-local",
      model: "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M",
      thinking: "medium",
    },
    reviewer: {
      provider: "openai-codex",
      model: "gpt-6-astra",
      thinking: "high",
    },
    repairer: {
      provider: "unsloth-local",
      model: "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M",
      thinking: "medium",
    },
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
  parallelImplementation: {
    enabled: true,
    maxParallelUnits: 2,
  },
  runRoot: ".pi/software-factory/runs",
  contextPaths: ["AGENTS.md", ".okf/project"],
  contextMaxBytes: 180_000,
  requireCleanWorkingTree: true,
  verificationCommands: [],
  maxDeterministicRepairPasses: 1,
  maxReviewRepairPasses: 2,
  maxWorkerContinuationPasses: 2,
  workerMaxRuntimeMinutes: 20,
  maxDiffCharsForReview: 120_000,
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateModelRef(role: ModelRole, ref: unknown): void {
  if (!isPlainRecord(ref)) {
    throw new Error(
      `Invalid models.${role}: expected an object with provider, model, and thinking fields.`,
    );
  }
  if (typeof ref.provider !== "string" || ref.provider.trim() === "") {
    throw new Error(`Invalid models.${role}.provider: expected a non-empty string.`);
  }
  if (typeof ref.model !== "string" || ref.model.trim() === "") {
    throw new Error(`Invalid models.${role}.model: expected a non-empty string.`);
  }
  if (typeof ref.thinking !== "string" || !THINKING_LEVELS.includes(ref.thinking as ThinkingLevel)) {
    throw new Error(
      `Invalid models.${role}.thinking: expected one of ${THINKING_LEVELS.join(", ")}.`,
    );
  }
}

/**
 * Validates a complete five-role models block. Runs on an explicitly supplied
 * block before deepMerge (so merging cannot conceal missing entries) and on
 * the effective block afterwards.
 */
function validateModelsBlock(models: unknown): void {
  if (!isPlainRecord(models)) {
    throw new Error(
      `Invalid models: expected an object with ${MODEL_ROLES.join(", ")} ModelRef entries.`,
    );
  }
  for (const role of MODEL_ROLES) {
    if (models[role] === undefined) {
      throw new Error(
        `Invalid models.${role}: expected a ModelRef with provider, model, and thinking fields.`,
      );
    }
    validateModelRef(role, models[role]);
  }
}

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

  // The qwen/astra buckets were replaced by the required models.<role> block.
  // Reject them explicitly so an obsolete local configuration cannot silently
  // select the shipped defaults; there is no code-side migration for them.
  for (const legacy of ["qwen", "astra"] as const) {
    if (legacy in parsed) {
      throw new Error(
        `Invalid configuration: the top-level "${legacy}" field is obsolete and no longer selects a model. ` +
          `Replace it with the required models block (${MODEL_ROLES.join(", ")}) in .pi/software-factory.json.`,
      );
    }
  }

  // Validate an explicitly supplied models block before deepMerge so a
  // partial block cannot be completed silently from the defaults.
  if ("models" in parsed) {
    validateModelsBlock(parsed.models);
  }

  // v0.9 split the shared repair budget into dedicated deterministic/review
  // budgets. Legacy configs carrying only maxRepairPasses migrate to setting
  // both dedicated limits to the same value; mixing the legacy key with either
  // dedicated key is a configuration error rather than a silent precedence rule.
  if ("maxRepairPasses" in parsed) {
    if ("maxDeterministicRepairPasses" in parsed || "maxReviewRepairPasses" in parsed) {
      throw new Error(
        "Invalid configuration: legacy maxRepairPasses cannot be combined with maxDeterministicRepairPasses or maxReviewRepairPasses. Remove maxRepairPasses and set the dedicated limits explicitly.",
      );
    }
    const legacy = parsed.maxRepairPasses;
    if (!Number.isSafeInteger(legacy) || legacy < 0) {
      throw new Error("Invalid maxRepairPasses: expected a non-negative integer.");
    }
    parsed.maxDeterministicRepairPasses = legacy;
    parsed.maxReviewRepairPasses = legacy;
    delete parsed.maxRepairPasses;
  }

  const config = deepMerge(structuredClone(DEFAULT_CONFIG), parsed);

  // Validate the effective models block as well, now that merging has
  // inherited any roles the user did not supply.
  validateModelsBlock(config.models);

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

  const parallel = config.parallelImplementation;
  if (typeof parallel.enabled !== "boolean") {
    throw new Error("Invalid parallelImplementation.enabled: expected a boolean.");
  }
  if (!Number.isSafeInteger(parallel.maxParallelUnits) || parallel.maxParallelUnits < 1) {
    throw new Error("Invalid parallelImplementation.maxParallelUnits: expected an integer >= 1.");
  }

  if (!Number.isSafeInteger(config.maxDeterministicRepairPasses) || config.maxDeterministicRepairPasses < 0) {
    throw new Error("Invalid maxDeterministicRepairPasses: expected a non-negative integer.");
  }
  if (!Number.isSafeInteger(config.maxReviewRepairPasses) || config.maxReviewRepairPasses < 0) {
    throw new Error("Invalid maxReviewRepairPasses: expected a non-negative integer.");
  }

  if (!Number.isSafeInteger(config.maxWorkerContinuationPasses) || config.maxWorkerContinuationPasses < 0) {
    throw new Error("Invalid maxWorkerContinuationPasses: expected a non-negative integer.");
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
