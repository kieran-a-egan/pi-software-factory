/**
 * Focused coverage for the frozen v1 autonomy-benchmark corpus
 * (benchmarks/autonomy/corpus/v1/).
 *
 * The corpus is a plain, frozen set of tiny solvable cases. This suite
 * exercises only the repository-safe, read-only concerns for the two cases in
 * this tranche:
 *
 * - each committed definition.json loads through node:fs + JSON.parse,
 *   validates under validateBenchmarkCaseDefinition, and the validated object
 *   deep-equals the parsed JSON so undeclared metadata cannot silently pass;
 * - the expected stable IDs are present, distinct, and carry the documented
 *   schema/kind/outcome/intervention policy;
 * - each validated ID maps to its directory, whose definition.json, assert.ts,
 *   and all three fixture files exist, and the v1 root holds exactly the two
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

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const corpusRoot = join(repoRoot, "benchmarks", "autonomy", "corpus", "v1");

/** The exact case directories this tranche contains, in declaration order. */
const EXPECTED_CASE_IDS = ["autonomy-v1-001", "autonomy-v1-002"] as const;

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
  it("contains exactly the two expected case directories", () => {
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

  it("declares two distinct stable case IDs", () => {
    const ids = EXPECTED_CASE_IDS.map((caseId) =>
      validateBenchmarkCaseDefinition(loadParsedDefinition(caseId)).id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["autonomy-v1-001", "autonomy-v1-002"]);
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
