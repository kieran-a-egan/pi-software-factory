/**
 * Focused coverage for the foundation contracts of the sequential,
 * fail-stop autonomy batch CLI (benchmarks/autonomy/run-batch-cli.ts),
 * exercised directly at their exported boundaries:
 *
 * - `parseBatchCliArgs` accepts exactly `--input`/`--output`/
 *   `--factory-config` in any order and returns exactly the parsed options,
 *   and separately rejects one missing required flag, one unknown flag, and
 *   one duplicate flag with contract-specific errors;
 * - `validateBatchManifest` rejects a malformed top-level structure
 *   (missing `cases`) and an unsupported `schemaVersion` "v2" before any
 *   case-file validation, and accepts a minimal valid case directory while
 *   rejecting a manifest that declares the same case id twice;
 * - `validateCaseIdForOutputDirectory` accepts a normal case id and rejects
 *   ids containing path separators or relative path segments;
 * - `validateFreshOutputPath` rejects an existing file or directory and
 *   accepts a nonexistent leaf without creating it;
 * - `validateFactoryConfigModels` projects a complete valid models block
 *   down to exactly `{ models, requireCleanWorkingTree: true }` (no host
 *   settings carried) and rejects a config lacking the explicit models
 *   block.
 *
 * No factory runs, no Git setup, no subprocesses, no benchmark execution:
 * all fixtures are generated inside the tests and removed afterward.
 */
import { afterEach, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseBatchCliArgs,
  validateBatchManifest,
  validateCaseIdForOutputDirectory,
  validateFactoryConfigModels,
  validateFreshOutputPath,
} from "../benchmarks/autonomy/run-batch-cli.js";
import type { CandidateFactoryConfig } from "../benchmarks/autonomy/run-batch-cli.js";

/** Temp roots created by this suite, removed reliably in `afterEach`. */
const tempRoots: string[] = [];

afterEach(async () => {
  const roots = tempRoots.splice(0);
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
});

it("parseBatchCliArgs accepts the three required flags in a noncanonical order and returns exactly the parsed options", () => {
  const options = parseBatchCliArgs([
    "--factory-config",
    "factory-config.json",
    "--output",
    "batch-out",
    "--input",
    "manifest.json",
  ]);
  expect(options).toEqual({
    input: "manifest.json",
    output: "batch-out",
    factoryConfig: "factory-config.json",
  });
});

it("parseBatchCliArgs rejects one missing required flag, one unknown flag, and one duplicate flag with contract-specific errors", () => {
  // One missing required flag: `--factory-config` absent.
  expect(() =>
    parseBatchCliArgs(["--input", "manifest.json", "--output", "batch-out"]),
  ).toThrowError("missing required flag(s): --factory-config");

  // One unknown flag, with all three required flags otherwise present.
  expect(() =>
    parseBatchCliArgs([
      "--input",
      "manifest.json",
      "--output",
      "batch-out",
      "--factory-config",
      "factory-config.json",
      "--bogus",
      "value",
    ]),
  ).toThrowError('unknown option "--bogus"');

  // One duplicate flag, with all three required flags otherwise present.
  expect(() =>
    parseBatchCliArgs([
      "--input",
      "manifest.json",
      "--input",
      "manifest-again.json",
      "--output",
      "batch-out",
      "--factory-config",
      "factory-config.json",
    ]),
  ).toThrowError("duplicate option --input");
});

it("validateBatchManifest rejects a malformed top-level structure and an unsupported schemaVersion before any case-file validation", async () => {
  // The supplied manifest directory does not exist, so no rejection in this
  // test can be a case-file error.
  const manifestDirectory = join(tmpdir(), "does-not-exist-batch-manifest");

  // Missing `cases` key with otherwise valid top-level fields.
  await expect(
    validateBatchManifest(
      { schemaVersion: "v1", factoryVersionRef: "pi-software-factory@v0.9.0" },
      manifestDirectory,
    ),
  ).rejects.toThrowError("manifest cases must be an array");

  // Unsupported `schemaVersion` fires before any case validation; the one
  // supplied case location does not exist, so a case-file error cannot be
  // confused with the schema rejection.
  await expect(
    validateBatchManifest(
      {
        schemaVersion: "v2",
        factoryVersionRef: "pi-software-factory@v0.9.0",
        cases: [{ caseDirectory: "does-not-exist", humanImplementationIntervention: false }],
      },
      manifestDirectory,
    ),
  ).rejects.toThrowError('manifest schemaVersion must be exactly "v1", got "v2"');
});

it("validateBatchManifest accepts a minimal valid case directory and rejects a duplicated case id", async () => {
  const root = await mkdtemp(join(tmpdir(), "batch-manifest-test-"));
  tempRoots.push(root);

  const caseDirectory = join(root, "cases", "autonomy-v1-001");
  const fixtureDirectory = join(caseDirectory, "fixture");
  await mkdir(fixtureDirectory, { recursive: true });
  await writeFile(
    join(caseDirectory, "definition.json"),
    JSON.stringify({
      id: "autonomy-v1-001",
      schemaVersion: "v1",
      kind: "solvable",
      category: "refactor",
      objective: "Refactor the fixture module without changing its behavior",
      expectedTerminalOutcome: "ACCEPTED",
      humanImplementationInterventionAllowed: false,
      assertionIdentifiers: ["assert-terminal-status"],
    }),
  );
  // Readable placeholder only; never imported or executed by this test.
  await writeFile(join(caseDirectory, "assert.ts"), "export {};\n");

  const entry = { caseDirectory: "cases/autonomy-v1-001", humanImplementationIntervention: false };

  const validated = await validateBatchManifest(
    { schemaVersion: "v1", factoryVersionRef: "pi-software-factory@v0.9.0", cases: [entry] },
    root,
  );
  expect(validated.cases).toHaveLength(1);
  expect(validated.cases[0]?.caseId).toBe("autonomy-v1-001");
  expect(validated.cases[0]?.humanImplementationIntervention).toBe(false);

  // Repeating the same entry declares the case id twice.
  await expect(
    validateBatchManifest(
      {
        schemaVersion: "v1",
        factoryVersionRef: "pi-software-factory@v0.9.0",
        cases: [entry, { ...entry }],
      },
      root,
    ),
  ).rejects.toThrowError('manifest case id "autonomy-v1-001" is declared more than once');
});

it("validateCaseIdForOutputDirectory accepts a normal case id and rejects separators and relative segments", () => {
  expect(() => validateCaseIdForOutputDirectory("autonomy-v1-001")).not.toThrow();

  expect(() => validateCaseIdForOutputDirectory("a/b")).toThrowError(
    "must not contain path separators",
  );
  expect(() => validateCaseIdForOutputDirectory("a\\b")).toThrowError(
    "must not contain path separators",
  );
  expect(() => validateCaseIdForOutputDirectory(".")).toThrowError(
    "must not be a relative path segment",
  );
  expect(() => validateCaseIdForOutputDirectory("..")).toThrowError(
    "must not be a relative path segment",
  );
});

it("validateFreshOutputPath rejects an existing file or directory and accepts a nonexistent leaf without creating it", async () => {
  const root = await mkdtemp(join(tmpdir(), "batch-output-test-"));
  tempRoots.push(root);

  const existingFile = join(root, "existing-file.txt");
  await writeFile(existingFile, "existing");
  expect(() => validateFreshOutputPath(existingFile)).toThrowError("already exists (file)");

  const existingDirectory = join(root, "existing-directory");
  await mkdir(existingDirectory);
  expect(() => validateFreshOutputPath(existingDirectory)).toThrowError("already exists (directory)");

  const freshLeaf = join(root, "fresh-leaf");
  expect(() => validateFreshOutputPath(freshLeaf)).not.toThrow();
  expect(existsSync(freshLeaf)).toBe(false);
});

it("validateFactoryConfigModels returns exactly the validated models block and the forced clean-tree gate, excluding host settings", () => {
  const expectedModels = {
    scout: { provider: "openai-codex", model: "gpt-6-astra", thinking: "high" },
    architect: { provider: "openai-codex", model: "gpt-6-astra", thinking: "high" },
    implementer: {
      provider: "unsloth-local",
      model: "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M",
      thinking: "medium",
    },
    reviewer: { provider: "openai-codex", model: "gpt-6-astra", thinking: "high" },
    repairer: {
      provider: "unsloth-local",
      model: "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M",
      thinking: "medium",
    },
  };
  const config: CandidateFactoryConfig = validateFactoryConfigModels(
    {
      models: expectedModels,
      // Unrelated host fields that must not be carried into the candidate.
      requireCleanWorkingTree: false,
      verificationCommands: ["npm test"],
      runRoot: "custom-run-root",
    },
    "factory-config.json",
  );
  expect(Object.keys(config).sort()).toEqual(["models", "requireCleanWorkingTree"]);
  expect(config).toEqual({ models: expectedModels, requireCleanWorkingTree: true });
});

it("validateFactoryConfigModels rejects a config lacking the explicit models block", () => {
  expect(() =>
    validateFactoryConfigModels(
      { verificationCommands: ["npm test"], requireCleanWorkingTree: false },
      "factory-config.json",
    ),
  ).toThrowError('missing explicit "models" block');
});
