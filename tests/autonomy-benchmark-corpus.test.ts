/**
 * Focused coverage for the frozen v1 autonomy-benchmark corpus
 * (benchmarks/autonomy/corpus/v1/).
 *
 * The corpus is a plain, frozen set of tiny solvable cases. This suite
 * exercises only the repository-safe, read-only concerns for the seven cases
 * in this tranche:
 *
 * - each committed definition.json loads through node:fs + JSON.parse,
 *   validates under validateBenchmarkCaseDefinition, and the validated object
 *   deep-equals the parsed JSON so undeclared metadata cannot silently pass;
 * - the expected stable IDs are present, distinct, and carry the documented
 *   schema/kind/outcome/intervention policy;
 * - each validated ID maps to its directory, whose definition.json, assert.ts,
 *   and all three fixture files exist, and the v1 root holds exactly the seven
 *   expected case directories;
 * - directly imported pristine fixture exports exhibit the documented
 *   pre-task defects/missing aliases plus the important existing behavior.
 *
 * Deliberately out of scope (kept out of this suite by design): importing or
 * executing the case-specific assertion scripts, launching compilers or
 * subprocesses, invoking the scoring/CLIs, or attempting any benchmark run.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateBenchmarkCaseDefinition } from "../benchmarks/autonomy/validate.js";
import { mean } from "../benchmarks/autonomy/corpus/v1/autonomy-v1-001/fixture/index.js";
import { parseBoolean } from "../benchmarks/autonomy/corpus/v1/autonomy-v1-002/fixture/index.js";
import { parsePort } from "../benchmarks/autonomy/corpus/v1/autonomy-v1-003/fixture/index.js";
import { last } from "../benchmarks/autonomy/corpus/v1/autonomy-v1-004/fixture/index.js";
import { unique } from "../benchmarks/autonomy/corpus/v1/autonomy-v1-005/fixture/index.js";
import { filterDefined } from "../benchmarks/autonomy/corpus/v1/autonomy-v1-006/fixture/index.js";
import { stripPrefix } from "../benchmarks/autonomy/corpus/v1/autonomy-v1-007/fixture/index.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const corpusRoot = join(repoRoot, "benchmarks", "autonomy", "corpus", "v1");

/** The exact case directories this tranche contains, in declaration order. */
const EXPECTED_CASE_IDS = ["autonomy-v1-001", "autonomy-v1-002", "autonomy-v1-003", "autonomy-v1-004", "autonomy-v1-005", "autonomy-v1-006", "autonomy-v1-007"] as const;

/** The artifact files every case directory must contain, relative to the case dir. */
const REQUIRED_ARTIFACTS = [
  "definition.json",
  "assert.ts",
  "fixture/index.ts",
  "fixture/tsconfig.json",
  "fixture/package.json",
] as const;

function loadParsedDefinition(caseId: string): unknown {
  const definitionPath = join(corpusRoot, caseId, "definition.json");
  return JSON.parse(readFileSync(definitionPath, "utf8"));
}

describe("autonomy-benchmark corpus v1", () => {
  it("contains exactly the seven expected case directories", () => {
    const entries = readdirSync(corpusRoot, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(directories).toEqual([...EXPECTED_CASE_IDS].sort());
  });

  for (const caseId of EXPECTED_CASE_IDS) {
    it(`${caseId}: the definition validates and matches its committed JSON`, () => {
      const parsed = loadParsedDefinition(caseId);
      const validated = validateBenchmarkCaseDefinition(parsed);
      // The frozen definitions carry only required fields; a deep-equality
      // check ensures no undeclared metadata could sneak through validation.
      expect(validated).toEqual(parsed);
    });

    it(`${caseId}: the definition records the documented policy`, () => {
      const validated = validateBenchmarkCaseDefinition(loadParsedDefinition(caseId));
      expect(validated.id).toBe(caseId);
      expect(validated.schemaVersion).toBe("v1");
      expect(validated.kind).toBe("solvable");
      expect(validated.expectedTerminalOutcome).toBe("ACCEPTED");
      expect(validated.humanImplementationInterventionAllowed).toBe(false);
    });

    it(`${caseId}: the ID maps to a directory holding every required artifact`, () => {
      const validated = validateBenchmarkCaseDefinition(loadParsedDefinition(caseId));
      const caseDir = join(corpusRoot, validated.id);
      for (const artifact of REQUIRED_ARTIFACTS) {
        expect(existsSync(join(caseDir, artifact)), `${artifact} must exist`).toBe(true);
      }
    });
  }

  it("declares seven distinct stable case IDs", () => {
    const ids = EXPECTED_CASE_IDS.map((caseId) =>
      validateBenchmarkCaseDefinition(loadParsedDefinition(caseId)).id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["autonomy-v1-001", "autonomy-v1-002", "autonomy-v1-003", "autonomy-v1-004", "autonomy-v1-005", "autonomy-v1-006", "autonomy-v1-007"]);
  });
});

describe("autonomy-v1-001 pristine mean fixture", () => {
  it("has the documented empty-array defect", () => {
    expect(Number.isNaN(mean([]))).toBe(true);
  });

  it("preserves the arithmetic mean for nonempty arrays", () => {
    expect(mean([2, 4])).toBe(3);
    expect(mean([-2, 2])).toBe(0);
    expect(mean([5])).toBe(5);
  });
});

describe("autonomy-v1-002 pristine parseBoolean fixture", () => {
  it("recognizes the existing 'true' and 'false' tokens", () => {
    expect(parseBoolean("true")).toBe(true);
    expect(parseBoolean("false")).toBe(false);
  });

  it("lacks the requested 'yes'/'no' aliases pre-task", () => {
    expect(parseBoolean("yes")).toBeUndefined();
    expect(parseBoolean("no")).toBeUndefined();
  });

  it("is case-sensitive, does not trim, and returns undefined for unsupported strings", () => {
    expect(parseBoolean("YES")).toBeUndefined();
    expect(parseBoolean(" true")).toBeUndefined();
    expect(parseBoolean("")).toBeUndefined();
  });
});

describe("autonomy-v1-003 pristine parsePort fixture", () => {
  it("has the documented zero-port defect", () => {
    expect(parsePort("0")).toBe(0);
  });

  it("preserves valid decimal ports including the upper bound", () => {
    expect(parsePort("1")).toBe(1);
    expect(parsePort("80")).toBe(80);
    expect(parsePort("443")).toBe(443);
    expect(parsePort("3000")).toBe(3000);
    expect(parsePort("65535")).toBe(65535);
  });

  it("rejects out-of-range, negative, fractional, whitespace, and nonnumeric inputs", () => {
    expect(parsePort("65536")).toBeUndefined();
    expect(parsePort("-1")).toBeUndefined();
    expect(parsePort("1.5")).toBeUndefined();
    expect(parsePort(" 80")).toBeUndefined();
    expect(parsePort("80 ")).toBeUndefined();
    expect(parsePort("")).toBeUndefined();
    expect(parsePort("abc")).toBeUndefined();
  });
});

describe("autonomy-v1-004 pristine last fixture", () => {
  it("has the documented first-element defect for nonempty arrays", () => {
    expect(last([1, 2, 3])).toBe(1);
    expect(last(["a", "b", "c"])).toBe("a");
  });

  it("returns the sole element for singleton arrays", () => {
    expect(last([1])).toBe(1);
    expect(last(["x"])).toBe("x");
  });

  it("preserves the existing empty-array behavior", () => {
    expect(last([])).toBeUndefined();
  });
});

describe("autonomy-v1-005 pristine unique fixture", () => {
  it("sorts the deduplicated result alphabetically instead of preserving first-occurrence order", () => {
    expect(unique(["b", "a", "b"])).toEqual(["a", "b"]);
  });

  it("retains exact case-sensitive deduplication and the empty-array behavior", () => {
    expect(unique(["a"])).toEqual(["a"]);
    expect(unique(["a", "A"])).toEqual(["A", "a"]);
    expect(unique([])).toEqual([]);
  });

  it("does not mutate the supplied array's contents or ordering", () => {
    const input = ["b", "a", "b"];
    expect(unique(input)).toEqual(["a", "b"]);
    expect(input).toEqual(["b", "a", "b"]);
  });
});

describe("autonomy-v1-006 pristine filterDefined fixture", () => {
  it("drops the legitimate falsy values 0, false, and '' along with nullish entries", () => {
    expect(filterDefined([0, 1, null])).toEqual([1]);
    expect(filterDefined([false, true, undefined])).toEqual([true]);
    expect(filterDefined(["", "x", null])).toEqual(["x"]);
  });

  it("filters empty and nullish inputs while preserving retained order", () => {
    expect(filterDefined([])).toEqual([]);
    expect(filterDefined([1, null, 2, undefined])).toEqual([1, 2]);
    expect(filterDefined([9, null, 3, undefined, 5, null, 3])).toEqual([9, 3, 5, 3]);
  });

  it("retains object elements in their original order as the same references", () => {
    const objectA = { id: "a" };
    const objectB = { id: "b" };
    const result = filterDefined([objectA, null, objectB, undefined]);
    expect(result).toEqual([objectA, objectB]);
    expect(result[0]).toBe(objectA);
    expect(result[1]).toBe(objectB);
  });

  it("does not mutate the supplied array", () => {
    const objectA = { id: "a" };
    const input: (number | string | typeof objectA | null | undefined)[] = [0, null, "x", undefined, objectA];
    const savedCopy = [...input];
    filterDefined(input);
    expect(input).toEqual(savedCopy);
    expect(input[4]).toBe(objectA);
  });
});

describe("autonomy-v1-007 pristine stripPrefix fixture", () => {
  it("removes the first literal occurrence of the prefix anywhere, not only a leading one", () => {
    expect(stripPrefix("valuepre", "pre")).toBe("value");
    expect(stripPrefix("xprevalue", "pre")).toBe("xvalue");
  });

  it("preserves true leading-prefix removal", () => {
    expect(stripPrefix("prevalue", "pre")).toBe("value");
  });

  it("leaves the value unchanged for an empty prefix", () => {
    expect(stripPrefix("value", "")).toBe("value");
  });
});
