import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.js";
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
