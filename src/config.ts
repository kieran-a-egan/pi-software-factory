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
  runRoot: ".okf/work",
  contextPaths: ["AGENTS.md", ".okf/project"],
  contextMaxBytes: 180_000,
  requireCleanWorkingTree: true,
  verificationCommands: [],
  maxRepairPasses: 1,
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

  if (!isAbsolute(config.runRoot)) config.runRoot = join(cwd, config.runRoot);
  return config;
}

export function resolveRunRoot(cwd: string, config: FactoryConfig): string {
  return isAbsolute(config.runRoot) ? config.runRoot : join(cwd, config.runRoot);
}
