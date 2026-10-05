import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, resolveConfig, THINKING_LEVELS } from "../src/config.js";
import type { FactoryConfig, ModelRef, ThinkingLevel } from "../src/types.js";

const ROLES = ["scout", "architect", "implementer", "reviewer", "repairer"] as const;
const ROLE_FIELDS = ["provider", "model", "thinking"] as const;

/** Five distinct, complete ModelRefs: mutating one role must not touch another. */
const VALID_MODELS: Record<(typeof ROLES)[number], ModelRef> = {
  scout: { provider: "prov-scout", model: "model-scout", thinking: "low" },
  architect: { provider: "prov-architect", model: "model-architect", thinking: "high" },
  implementer: { provider: "prov-implementer", model: "model-implementer", thinking: "off" },
  reviewer: { provider: "prov-reviewer", model: "model-reviewer", thinking: "max" },
  repairer: { provider: "prov-repairer", model: "model-repairer", thinking: "xhigh" },
};

const EXAMPLE_CONFIG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "software-factory.example.json",
);

const configPaths: string[] = [];

function writeConfig(dir: string, value: unknown): string {
  const piDir = join(dir, ".pi");
  mkdirSync(piDir, { recursive: true });
  const path = join(piDir, "software-factory.json");
  writeFileSync(path, JSON.stringify(value));
  configPaths.push(dir);
  return dir;
}

function loadFrom(value: unknown): FactoryConfig {
  return loadConfig(writeConfig(mkdtempSync(join(tmpdir(), "sf-config-")), value));
}

afterEach(() => {
  while (configPaths.length > 0) {
    rmSync(configPaths.pop()!, { recursive: true, force: true });
  }
});

describe("repair budget defaults", () => {
  it("exposes deterministic=1 and review=2 in DEFAULT_CONFIG", () => {
    expect(DEFAULT_CONFIG.maxDeterministicRepairPasses).toBe(1);
    expect(DEFAULT_CONFIG.maxReviewRepairPasses).toBe(2);
  });

  it("returns the dedicated defaults when no config file exists", () => {
    const empty = mkdtempSync(join(tmpdir(), "sf-config-"));
    configPaths.push(empty);
    const config = loadConfig(empty);
    expect(config.maxDeterministicRepairPasses).toBe(1);
    expect(config.maxReviewRepairPasses).toBe(2);
  });

  it("returns the dedicated defaults for an empty config object", () => {
    const config = loadFrom({});
    expect(config.maxDeterministicRepairPasses).toBe(1);
    expect(config.maxReviewRepairPasses).toBe(2);
    expect(config).not.toHaveProperty("maxRepairPasses");
  });
});

describe("explicit dedicated repair limits", () => {
  it("accepts maxDeterministicRepairPasses alone and inherits the review default", () => {
    const config = loadFrom({ maxDeterministicRepairPasses: 3 });
    expect(config.maxDeterministicRepairPasses).toBe(3);
    expect(config.maxReviewRepairPasses).toBe(2);
  });

  it("accepts maxReviewRepairPasses alone and inherits the deterministic default", () => {
    const config = loadFrom({ maxReviewRepairPasses: 4 });
    expect(config.maxDeterministicRepairPasses).toBe(1);
    expect(config.maxReviewRepairPasses).toBe(4);
  });

  it("accepts both dedicated limits set together", () => {
    const config = loadFrom({ maxDeterministicRepairPasses: 2, maxReviewRepairPasses: 5 });
    expect(config.maxDeterministicRepairPasses).toBe(2);
    expect(config.maxReviewRepairPasses).toBe(5);
  });

  it("accepts zero for each dedicated limit", () => {
    const config = loadFrom({ maxDeterministicRepairPasses: 0, maxReviewRepairPasses: 0 });
    expect(config.maxDeterministicRepairPasses).toBe(0);
    expect(config.maxReviewRepairPasses).toBe(0);
  });

  it("accepts distinct non-default positive values without coupling them", () => {
    const config = loadFrom({ maxDeterministicRepairPasses: 7, maxReviewRepairPasses: 11 });
    expect(config.maxDeterministicRepairPasses).toBe(7);
    expect(config.maxReviewRepairPasses).toBe(11);
  });
});

describe("invalid dedicated repair limits", () => {
  const field = "maxDeterministicRepairPasses";
  const values: Record<string, number | string | null> = {
    negative: -1,
    fractional: 1.5,
    string: "2",
    null: null,
    "unsafe integer": 2 ** 53,
  };

  for (const key of [field, "maxReviewRepairPasses"] as const) {
    for (const [label, value] of Object.entries(values)) {
      it(`rejects ${key}=${JSON.stringify(value)} (${label})`, () => {
        expect(() => loadFrom({ [key]: value })).toThrowError(
          new RegExp(`Invalid ${key}: expected a non-negative integer\\.`),
        );
      });
    }
  }
});

describe("legacy maxRepairPasses migration", () => {
  it.each([[0], [1], [3]])("maps legacy-only maxRepairPasses=%s to both dedicated limits", (legacy) => {
    const config = loadFrom({ maxRepairPasses: legacy });
    expect(config.maxDeterministicRepairPasses).toBe(legacy);
    expect(config.maxReviewRepairPasses).toBe(legacy);
    expect(config).not.toHaveProperty("maxRepairPasses");
  });

  it.each([[ -1, "Invalid maxRepairPasses: expected a non-negative integer." ], [1.5, "Invalid maxRepairPasses: expected a non-negative integer." ], ["2", "Invalid maxRepairPasses: expected a non-negative integer." ], [null, "Invalid maxRepairPasses: expected a non-negative integer." ], [2 ** 53, "Invalid maxRepairPasses: expected a non-negative integer." ]])(
    "rejects invalid legacy maxRepairPasses=%s",
    (value, message) => {
      expect(() => loadFrom({ maxRepairPasses: value })).toThrowError(message);
    },
  );
});

describe("default semantic role models", () => {
  it("ships the exact five-role assignments in DEFAULT_CONFIG", () => {
    expect(DEFAULT_CONFIG.models.scout).toEqual({
      provider: "unsloth-local",
      model: "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M",
      thinking: "medium",
    });
    expect(DEFAULT_CONFIG.models.architect).toEqual({
      provider: "openai-codex",
      model: "gpt-6-astra",
      thinking: "high",
    });
    expect(DEFAULT_CONFIG.models.implementer).toEqual(DEFAULT_CONFIG.models.scout);
    expect(DEFAULT_CONFIG.models.reviewer).toEqual(DEFAULT_CONFIG.models.architect);
    expect(DEFAULT_CONFIG.models.repairer).toEqual(DEFAULT_CONFIG.models.scout);
  });

  it("no longer exposes qwen/astra buckets on FactoryConfig", () => {
    expect(DEFAULT_CONFIG).not.toHaveProperty("qwen");
    expect(DEFAULT_CONFIG).not.toHaveProperty("astra");
    expect(Object.keys(DEFAULT_CONFIG.models).sort()).toEqual([...ROLES].sort());
  });

  it("uses independent role objects so mutating one role does not alter another", () => {
    const roles = DEFAULT_CONFIG.models as unknown as Record<string, ModelRef>;
    for (const a of ROLES) {
      for (const b of ROLES) {
        if (a !== b) expect(roles[a]).not.toBe(roles[b]);
      }
    }
    roles.scout.provider = "mutated";
    for (const role of ROLES) {
      expect(roles[role].provider).toBe(DEFAULT_CONFIG.models[role].provider);
    }
    roles.scout.provider = "unsloth-local";
  });

  it("returns a default clone that does not share mutable role references with DEFAULT_CONFIG", () => {
    const empty = mkdtempSync(join(tmpdir(), "sf-config-"));
    configPaths.push(empty);
    const config = loadConfig(empty);
    expect(config.models).toEqual(DEFAULT_CONFIG.models);
    for (const role of ROLES) {
      expect(config.models[role]).not.toBe(DEFAULT_CONFIG.models[role]);
    }
    config.models.scout.provider = "mutated";
    expect(DEFAULT_CONFIG.models.scout.provider).toBe("unsloth-local");
  });

  it("inherits the complete default models when a configuration omits models", () => {
    const config = loadFrom({ maxReviewRepairPasses: 4 });
    expect(config.models).toEqual(DEFAULT_CONFIG.models);
    expect(config.maxReviewRepairPasses).toBe(4);
  });

  it("accepts five distinct valid ModelRefs without cross-role coupling", () => {
    const config = loadFrom({ models: structuredClone(VALID_MODELS) });
    expect(config.models).toEqual(VALID_MODELS);
    for (const a of ROLES) {
      for (const b of ROLES) {
        if (a !== b) expect(config.models[a]).not.toBe(config.models[b]);
      }
    }
  });

  it("accepts every permitted ThinkingLevel in a complete models block", () => {
    const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    for (const level of levels) {
      const models = structuredClone(VALID_MODELS);
      for (const role of ROLES) models[role].thinking = level;
      const config = loadFrom({ models });
      for (const role of ROLES) expect(config.models[role].thinking).toBe(level);
    }
  });
});

describe("explicitly supplied models block validation", () => {
  it.each(ROLES)("rejects a models block missing models.%s with a field-specific error", (role) => {
    const models = structuredClone(VALID_MODELS);
    delete (models as Record<string, unknown>)[role];
    expect(() => loadFrom({ models })).toThrowError(new RegExp(`Invalid models\\.${role}:`));
  });

  for (const role of ROLES) {
    for (const field of ROLE_FIELDS) {
      it(`rejects models.${role} without its ${field} field`, () => {
        const models = structuredClone(VALID_MODELS);
        delete models[role][field];
        expect(() => loadFrom({ models })).toThrowError(
          new RegExp(`Invalid models\\.${role}\\.${field}:`),
        );
      });
    }
  }

  it.each([
    [null, "null"],
    [[], "array"],
    ["unsloth-local", "string"],
    [42, "number"],
  ])("rejects models as a %s container", (value: unknown, _label: string) => {
    expect(() => loadFrom({ models: value })).toThrowError(
      /Invalid models: expected an object with scout, architect, implementer, reviewer, repairer ModelRef entries\./,
    );
  });

  for (const role of ROLES) {
    it.each([
      [null, "null"],
      [[], "array"],
      ["unsloth-local", "string"],
      [42, "number"],
    ])(`rejects models.${role} as a %s value`, (value: unknown, _label: string) => {
      const models = structuredClone(VALID_MODELS);
      (models as Record<string, unknown>)[role] = value;
      expect(() => loadFrom({ models })).toThrowError(
        new RegExp(`Invalid models\\.${role}: expected an object with provider, model, and thinking fields\.`),
      );
    });
  }

  for (const role of ROLES) {
    for (const field of ["provider", "model"] as const) {
      it.each([
        ["", "empty string"],
        ["   ", "whitespace string"],
        [42, "number"],
        [null, "null"],
      ])(`rejects models.${role}.${field} as a %s value`, (value: unknown, _label: string) => {
        const models = structuredClone(VALID_MODELS);
        (models[role] as unknown as Record<string, unknown>)[field] = value;
        expect(() => loadFrom({ models })).toThrowError(
          new RegExp(`Invalid models\\.${role}\\.${field}: expected a non-empty string\.`),
        );
      });
    }
  }

  for (const role of ROLES) {
    it.each([
      ["turbo", "unknown level"],
      ["MEDIUM", "wrong case"],
      [3, "number"],
      [null, "null"],
    ])(`rejects models.${role}.thinking as a %s value`, (value: unknown, _label: string) => {
      const models = structuredClone(VALID_MODELS);
      (models[role] as unknown as Record<string, unknown>).thinking = value;
      expect(() => loadFrom({ models })).toThrowError(
        /Invalid models\.[a-z]+\.thinking: expected one of off, minimal, low, medium, high, xhigh, max\./,
      );
    });
  }
});

describe("obsolete qwen/astra top-level fields", () => {
  const legacyRef = { provider: "unsloth-local", model: "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M", thinking: "medium" };

  it.each(["qwen", "astra"])("rejects a lone top-level %s with a migration instruction", (legacy) => {
    expect(() => loadFrom({ [legacy]: legacyRef })).toThrowError(
      new RegExp(
        'the top-level "' + legacy + '" field is obsolete.*Replace it with the required models block \\(scout, architect, implementer, reviewer, repairer\\)',
      ),
    );
  });

  it("rejects qwen alongside a complete valid models block (no fallback)", () => {
    expect(() => loadFrom({ qwen: legacyRef, models: structuredClone(VALID_MODELS) })).toThrowError(
      /the top-level "qwen" field is obsolete/,
    );
  });

  it("rejects astra alongside a complete valid models block (no fallback)", () => {
    expect(() => loadFrom({ astra: legacyRef, models: structuredClone(VALID_MODELS) })).toThrowError(
      /the top-level "astra" field is obsolete/,
    );
  });

  it("rejects both legacy fields together and names the first one", () => {
    expect(() => loadFrom({ qwen: legacyRef, astra: legacyRef })).toThrowError(
      /the top-level "qwen" field is obsolete/,
    );
  });

  it("directs the user to the models block in the actionable message", () => {
    try {
      loadFrom({ astra: legacyRef });
      throw new Error("expected loadFrom to throw");
    } catch (error) {
      expect(String(error)).toContain("models");
      expect(String(error)).toContain(".pi/software-factory.json");
    }
  });
});

describe("shipped example configuration", () => {
  const example = JSON.parse(readFileSync(EXAMPLE_CONFIG_PATH, "utf8")) as Record<string, unknown>;

  it("contains no qwen/astra buckets and a complete models block", () => {
    expect(example).not.toHaveProperty("qwen");
    expect(example).not.toHaveProperty("astra");
    expect(Object.keys(example.models as object).sort()).toEqual([...ROLES].sort());
  });

  it("loads successfully and its model block matches the shipped defaults", () => {
    const config = loadFrom(example);
    expect(config.models).toEqual(DEFAULT_CONFIG.models);
    expect(config.jev).toEqual(DEFAULT_CONFIG.jev);
    expect(config.runRoot.endsWith(join(".pi", "software-factory", "runs"))).toBe(true);
  });
});

describe("legacy key mixed with dedicated keys", () => {
  it.each([
    [{ maxRepairPasses: 1, maxDeterministicRepairPasses: 1 }, "maxDeterministicRepairPasses"],
    [{ maxRepairPasses: 2, maxReviewRepairPasses: 2 }, "maxReviewRepairPasses"],
    [{ maxRepairPasses: 3, maxDeterministicRepairPasses: 3, maxReviewRepairPasses: 3 }, "maxDeterministicRepairPasses or maxReviewRepairPasses"],
  ])("rejects %j with a migration error even when the values agree", (config, mentioned) => {
    expect(() => loadFrom(config)).toThrowError(
      /legacy maxRepairPasses cannot be combined with .*Remove maxRepairPasses and set the dedicated limits explicitly\./,
    );
    try {
      loadFrom(config);
    } catch (error) {
      expect(String(error)).toContain(mentioned);
    }
  });
});

describe("THINKING_LEVELS export", () => {
  it("exports exactly off, minimal, low, medium, high, xhigh, max in that order", () => {
    expect([...THINKING_LEVELS]).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });
});

describe("resolveConfig (shared in-memory boundary)", () => {
  it("performs no filesystem access: a missing cwd with a relative runRoot still resolves", () => {
    const cwd = join(tmpdir(), "sf-config-missing-cwd", "does-not-exist");
    const config = resolveConfig(cwd, {});
    expect(config.runRoot).toBe(join(cwd, ".pi", "software-factory", "runs"));
  });

  it("returns the effective config for a representative valid input without any file", () => {
    const cwd = join(tmpdir(), "sf-config-no-file");
    const value = {
      models: structuredClone(VALID_MODELS),
      jev: { model: "jev-custom", minChoiceConfidence: 0.7, minNoulProbability: 0.8 },
      maxDeterministicRepairPasses: 3,
      maxReviewRepairPasses: 5,
      verificationCommands: ["npm test"],
    };
    const config = resolveConfig(cwd, value);
    expect(config.models).toEqual(VALID_MODELS);
    expect(config.jev).toEqual({ model: "jev-custom", minChoiceConfidence: 0.7, minNoulProbability: 0.8 });
    expect(config.maxDeterministicRepairPasses).toBe(3);
    expect(config.maxReviewRepairPasses).toBe(5);
    expect(config.verificationCommands).toEqual(["npm test"]);
    expect(config.runRoot).toBe(join(cwd, ".pi", "software-factory", "runs"));
  });

  it.each([
    [null, "null"],
    [[], "array"],
    ["{}", "string"],
    [42, "number"],
    [true, "boolean"],
    [false, "boolean"],
  ])("rejects a %s root explicitly", (value: unknown, _label: string) => {
    expect(() => resolveConfig(tmpdir(), value)).toThrowError(
      /expected a JSON object at the top level\./,
    );
  });

  it.each(["qwen", "astra"])("keeps obsolete top-level %s rejection with the migration instruction", (legacy) => {
    expect(() => resolveConfig(tmpdir(), { [legacy]: { provider: "p", model: "m", thinking: "low" } })).toThrowError(
      new RegExp(
        'the top-level "' + legacy + '" field is obsolete.*Replace it with the required models block \\(scout, architect, implementer, reviewer, repairer\\)',
      ),
    );
  });

  it("keeps field-specific model and budget errors intact", () => {
    const models = structuredClone(VALID_MODELS);
    models.scout.thinking = "turbo" as ThinkingLevel;
    expect(() => resolveConfig(tmpdir(), { models })).toThrowError(
      /Invalid models\.scout\.thinking: expected one of off, minimal, low, medium, high, xhigh, max\./,
    );
    const missingModel = structuredClone(VALID_MODELS);
    delete (missingModel.architect as unknown as Record<string, unknown>)["model"];
    expect(() => resolveConfig(tmpdir(), { models: missingModel })).toThrowError(
      /Invalid models\.architect\.model: expected a non-empty string\./,
    );
    expect(() =>
      resolveConfig(tmpdir(), { contextBudget: { warningTokens: 50, checkpointTokens: 40, hardLimitTokens: 60 } }),
    ).toThrowError(/Invalid contextBudget: require 0 < warningTokens < checkpointTokens < hardLimitTokens\./);
    expect(() => resolveConfig(tmpdir(), { planningLoops: { maxRescoutPasses: -1 } })).toThrowError(
      /Invalid planningLoops\.maxRescoutPasses: expected a non-negative integer\./,
    );
    expect(() => resolveConfig(tmpdir(), { parallelImplementation: { maxParallelUnits: 0 } })).toThrowError(
      /Invalid parallelImplementation\.maxParallelUnits: expected an integer >= 1\./,
    );
    expect(() => resolveConfig(tmpdir(), { maxDeterministicRepairPasses: -2 })).toThrowError(
      /Invalid maxDeterministicRepairPasses: expected a non-negative integer\./,
    );
    expect(() => resolveConfig(tmpdir(), { workerMaxRuntimeMinutes: 0 })).toThrowError(
      /Invalid workerMaxRuntimeMinutes: expected a positive number\./,
    );
  });

  it("leaves the caller input deeply unchanged on success, including repair migration", () => {
    const value = {
      maxRepairPasses: 4,
      jev: { minChoiceConfidence: 0.7 },
      models: structuredClone(VALID_MODELS),
      contextBudget: { warningTokens: 10 },
    };
    const before = structuredClone(value);
    const config = resolveConfig(tmpdir(), value);
    expect(value).toEqual(before);
    expect(config.maxDeterministicRepairPasses).toBe(4);
    expect(config.maxReviewRepairPasses).toBe(4);
  });

  it("leaves the caller input deeply unchanged on failure, including mixed repair keys", () => {
    const value = { maxRepairPasses: 1, maxDeterministicRepairPasses: 1, models: structuredClone(VALID_MODELS) };
    const before = structuredClone(value);
    expect(() => resolveConfig(tmpdir(), value)).toThrowError(
      /legacy maxRepairPasses cannot be combined/,
    );
    expect(value).toEqual(before);

    const badValue = { models: structuredClone(VALID_MODELS) as unknown as Record<string, unknown> };
    delete badValue.models["scout"];
    const badBefore = structuredClone(badValue);
    expect(() => resolveConfig(tmpdir(), badValue)).toThrowError(/Invalid models\.scout:/);
    expect(badValue).toEqual(badBefore);
  });

  it("does not share mutable nested values with the caller input or DEFAULT_CONFIG", () => {
    const value = { jev: { minChoiceConfidence: 0.7 } };
    const config = resolveConfig(tmpdir(), value);
    config.jev.model = "mutated";
    config.models.scout.provider = "mutated";
    config.contextBudget.warningTokens = 1;
    config.verificationCommands.push("extra");
    expect(value).toEqual({ jev: { minChoiceConfidence: 0.7 } });
    expect(DEFAULT_CONFIG.jev.model).toBe("jev-latest");
    expect(DEFAULT_CONFIG.models.scout.provider).toBe("unsloth-local");
    expect(DEFAULT_CONFIG.contextBudget.warningTokens).toBe(65_000);
    expect(DEFAULT_CONFIG.verificationCommands).toEqual([]);
  });
});

describe("loadConfig / resolveConfig equivalence", () => {
  const CASES: Array<[string, Record<string, unknown>]> = [
    ["complete models block", { models: structuredClone(VALID_MODELS) }],
    ["omitted defaults", {}],
    ["dedicated budgets", { maxDeterministicRepairPasses: 3, maxReviewRepairPasses: 5 }],
    ["legacy maxRepairPasses", { maxRepairPasses: 2 }],
    [".okf/work alias", { runRoot: ".okf/work" }],
    ["relative runRoot", { runRoot: "custom/runs" }],
    ["absolute runRoot", { runRoot: join(tmpdir(), "sf-config-abs-runs") }],
    ["context budgets", { contextBudget: { warningTokens: 10, checkpointTokens: 20, hardLimitTokens: 30, maxCheckpointsPerStage: 1 } }],
    ["planning loops", { planningLoops: { maxRescoutPasses: 3, maxReplanPasses: 1 } }],
    ["parallelism", { parallelImplementation: { enabled: false, maxParallelUnits: 4 } }],
    [
      "preserved Jev and verification values",
      {
        jev: { model: "jev-custom", minChoiceConfidence: 0.7, minNoulProbability: 0.8 },
        verificationCommands: ["npm test"],
        contextPaths: ["AGENTS.md"],
        contextMaxBytes: 100_000,
        requireCleanWorkingTree: false,
        maxWorkerContinuationPasses: 3,
        workerMaxRuntimeMinutes: 30,
        maxDiffCharsForReview: 40_000,
      },
    ],
  ];

  for (const [label, value] of CASES) {
    it(`yields equal effective configs for ${label}`, () => {
      const dir = writeConfig(mkdtempSync(join(tmpdir(), "sf-config-")), structuredClone(value));
      expect(resolveConfig(dir, structuredClone(value))).toEqual(loadConfig(dir));
    });
  }

  it("returns an independent default clone with its existing relative runRoot when the file is absent", () => {
    const empty = mkdtempSync(join(tmpdir(), "sf-config-"));
    configPaths.push(empty);
    const config = loadConfig(empty);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(config.runRoot).toBe(".pi/software-factory/runs");
    expect(config).not.toBe(DEFAULT_CONFIG);
    config.jev.model = "mutated";
    expect(DEFAULT_CONFIG.jev.model).toBe("jev-latest");
  });

  it("still fails through loadConfig for malformed JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-config-"));
    configPaths.push(dir);
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "software-factory.json"), "{ not valid json");
    expect(() => loadConfig(dir)).toThrowError(SyntaxError);
  });
});
