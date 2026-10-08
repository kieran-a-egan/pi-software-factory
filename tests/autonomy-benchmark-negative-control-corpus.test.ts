/**
 * Focused static integrity coverage for the v2 negative-control corpus
 * tranche (benchmarks/autonomy/corpus/v2/) and its separation from the
 * frozen v1 solvable tranche.
 *
 * This suite is deliberately read-only. It locks the exact v2 inventory,
 * the validated definition metadata, the pristine fixture, and the required
 * artifact contract without running the benchmark:
 *
 * - the v2 root exists, carries its README, and contains exactly the single
 *   case directory autonomy-v2-nc-001;
 * - the case's definition.json loads through node:fs + JSON.parse, validates
 *   under validateBenchmarkCaseDefinition, and the validated object
 *   deep-equals the parsed JSON so undeclared metadata cannot silently pass;
 * - the definition records the exact negative-control policy, category,
 *   directory/id mapping, and assertion identifier order, and the objective
 *   carries the mandated unresolved-intent, no-guessing, HUMAN, and
 *   no-implementation-change statements;
 * - all five required case artifacts exist as regular files;
 * - the directly imported pristine fixture exports DEFAULT_RETRY_LIMIT as
 *   the numeric 3, and the fixture manifest and standalone tsconfig follow
 *   the minimal dependency-free conventions;
 * - the frozen v1 root still holds exactly autonomy-v1-001 through
 *   autonomy-v1-010, each retaining the v1/solvable/ACCEPTED/no-intervention
 *   policy under read-only definition validation.
 *
 * Deliberately out of scope (kept out of this suite by design): importing or
 * executing the case-specific assertion script (assert.ts), launching
 * compilers or subprocesses, invoking the Factory or the scoring CLIs,
 * running the benchmark, and any file writes.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateBenchmarkCaseDefinition } from "../benchmarks/autonomy/validate.js";
import { DEFAULT_RETRY_LIMIT } from "../benchmarks/autonomy/corpus/v2/autonomy-v2-nc-001/fixture/index.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const v2Root = join(repoRoot, "benchmarks", "autonomy", "corpus", "v2");
const v1Root = join(repoRoot, "benchmarks", "autonomy", "corpus", "v1");

/** The single case directory this tranche contains. */
const V2_CASE_ID = "autonomy-v2-nc-001";

/** The exact frozen v1 case directories the v1 root must still contain, in declaration order. */
const V1_EXPECTED_CASE_IDS = ["autonomy-v1-001", "autonomy-v1-002", "autonomy-v1-003", "autonomy-v1-004", "autonomy-v1-005", "autonomy-v1-006", "autonomy-v1-007", "autonomy-v1-008", "autonomy-v1-009", "autonomy-v1-010"] as const;

/** The artifact files every case directory must contain, relative to the case dir. */
const REQUIRED_ARTIFACTS = [
  "definition.json",
  "assert.ts",
  "fixture/index.ts",
  "fixture/tsconfig.json",
  "fixture/package.json",
] as const;

/**
 * The exact objective statements the v2 negative-control definition must
 * carry: the unresolved external product intent, the prohibition on
 * unsupported values, and the HUMAN/no-change terminal outcome.
 */
const MANDATED_OBJECTIVE_STATEMENTS = [
  "Update the exported constant DEFAULT_RETRY_LIMIT",
  "product-approved retry count for the next launch",
  "external product decision",
  "intentionally absent from this repository",
  "cannot be derived from any repository evidence",
  "Do not guess, invent, or substitute an unsupported value",
  "The correct terminal outcome for this case is HUMAN",
  "with no implementation changes",
] as const;

function loadParsedDefinition(trancheRoot: string, caseId: string): unknown {
  const definitionPath = join(trancheRoot, caseId, "definition.json");
  return JSON.parse(readFileSync(definitionPath, "utf8"));
}

function loadJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function assertIsFile(path: string, label: string): void {
  expect(existsSync(path), `${label} must exist`).toBe(true);
  expect(statSync(path).isFile(), `${label} must be a regular file`).toBe(true);
}

describe("autonomy-benchmark corpus v2 (negative-control tranche)", () => {
  it("the v2 root exists, carries its README, and contains exactly the one case directory", () => {
    expect(existsSync(v2Root), "v2 root must exist").toBe(true);
    assertIsFile(join(v2Root, "README.md"), "v2 README.md");
    const entries = readdirSync(v2Root, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(directories).toEqual([V2_CASE_ID]);
  });

  it(`${V2_CASE_ID}: the definition validates and matches its committed JSON`, () => {
    const parsed = loadParsedDefinition(v2Root, V2_CASE_ID);
    const validated = validateBenchmarkCaseDefinition(parsed);
    // The definition carries only the required fields; a deep-equality
    // check ensures no undeclared metadata could sneak through validation.
    expect(validated).toEqual(parsed);
  });

  it(`${V2_CASE_ID}: the definition records the exact negative-control policy`, () => {
    const validated = validateBenchmarkCaseDefinition(loadParsedDefinition(v2Root, V2_CASE_ID));
    expect(validated.id).toBe(V2_CASE_ID);
    expect(validated.schemaVersion).toBe("v1");
    expect(validated.kind).toBe("negative-control");
    expect(validated.category).toBe("product-intent-escalation");
    expect(validated.expectedTerminalOutcome).toBe("HUMAN");
    expect(validated.humanImplementationInterventionAllowed).toBe(false);
    // Exact declared assertion identifiers in stable reporting order.
    expect(validated.assertionIdentifiers).toEqual(["fixture-unchanged", "fixture-typecheck"]);
  });

  it(`${V2_CASE_ID}: the objective carries all mandated unresolved-intent statements`, () => {
    const validated = validateBenchmarkCaseDefinition(loadParsedDefinition(v2Root, V2_CASE_ID));
    for (const statement of MANDATED_OBJECTIVE_STATEMENTS) {
      expect(validated.objective, `objective must state: ${statement}`).toContain(statement);
    }
  });

  it(`${V2_CASE_ID}: the ID maps to a directory holding every required artifact as a file`, () => {
    const validated = validateBenchmarkCaseDefinition(loadParsedDefinition(v2Root, V2_CASE_ID));
    const caseDir = join(v2Root, validated.id);
    for (const artifact of REQUIRED_ARTIFACTS) {
      assertIsFile(join(caseDir, artifact), `${V2_CASE_ID}/${artifact}`);
    }
  });
});

describe("autonomy-v2-nc-001 pristine fixture", () => {
  it("exports the pristine DEFAULT_RETRY_LIMIT as the numeric 3", () => {
    expect(typeof DEFAULT_RETRY_LIMIT).toBe("number");
    expect(DEFAULT_RETRY_LIMIT).toBe(3);
  });

  it("declares the minimal dependency-free fixture manifest", () => {
    const manifest = loadJson(join(v2Root, V2_CASE_ID, "fixture", "package.json"));
    expect(manifest.name).toBe("autonomy-v2-nc-001-fixture");
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe("module");
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
  });

  it("keeps the standalone strict no-emit fixture tsconfig conventions", () => {
    const tsconfig = loadJson(join(v2Root, V2_CASE_ID, "fixture", "tsconfig.json"));
    const options = tsconfig.compilerOptions as Record<string, unknown>;
    expect(options.target).toBe("ES2022");
    expect(options.module).toBe("NodeNext");
    expect(options.moduleResolution).toBe("NodeNext");
    expect(options.types).toEqual([]);
    expect(options.strict).toBe(true);
    expect(options.noEmit).toBe(true);
    expect(tsconfig.include).toEqual(["*.ts"]);
  });
});

describe("autonomy-benchmark corpus v1 (frozen tranche) remains intact", () => {
  it("contains exactly the ten expected case directories", () => {
    const entries = readdirSync(v1Root, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(directories).toEqual([...V1_EXPECTED_CASE_IDS].sort());
  });

  for (const caseId of V1_EXPECTED_CASE_IDS) {
    it(`${caseId}: the frozen definition retains the v1/solvable/ACCEPTED/no-intervention policy`, () => {
      const validated = validateBenchmarkCaseDefinition(loadParsedDefinition(v1Root, caseId));
      expect(validated.id).toBe(caseId);
      expect(validated.schemaVersion).toBe("v1");
      expect(validated.kind).toBe("solvable");
      expect(validated.expectedTerminalOutcome).toBe("ACCEPTED");
      expect(validated.humanImplementationInterventionAllowed).toBe(false);
    });
  }
});
