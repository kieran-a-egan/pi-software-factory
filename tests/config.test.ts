import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.js";
import type { FactoryConfig } from "../src/types.js";

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
