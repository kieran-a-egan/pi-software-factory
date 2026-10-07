/**
 * Focused integration coverage for `prepareCandidate` in
 * benchmarks/autonomy/run-batch-cli.ts, exercised through the real local Git
 * executable (the production process runner) against disposable fixtures
 * generated inside each test:
 *
 * - a valid case prepares into a nonexistent per-case output directory: the
 *   candidate root is `<caseOutputDirectory>/candidate` with its own `.git`
 *   directory, the returned baseline SHA matches /^[0-9a-f]{40}$/,
 *   `git rev-parse HEAD` agrees with it, and `git rev-list --count HEAD`
 *   reports exactly one commit;
 * - the prepared candidate has a clean working tree (`git status
 *   --porcelain --untracked-files=all` is empty) and its
 *   `.git/info/exclude` carries the exact `/.pi/` line;
 * - the fixture files (root and nested) are committed in the baseline SHA,
 *   while `.pi/software-factory.json` is absent from the commit, present on
 *   disk, and parses to exactly `{ models, requireCleanWorkingTree: true }`
 *   with no extra properties;
 * - a pre-existing per-case output directory is rejected with the
 *   existing-directory freshness error, its sentinel content is preserved,
 *   and no candidate directory is created or reused.
 *
 * `validateBatchManifest` is used only to obtain valid setup inputs (no
 * assertions about its parsing or validation). Independent Git state is
 * inspected directly with real `git` invocations. No Pi, no runBatch, no
 * assertion execution, no scoring.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

import {
  createProductionProcessRunner,
  prepareCandidate,
  validateBatchManifest,
} from "../benchmarks/autonomy/run-batch-cli.js";
import type { CandidateFactoryConfig, ValidatedBatchCase } from "../benchmarks/autonomy/run-batch-cli.js";
import type { ModelRoles } from "../src/types.js";
import { GIT_INTEGRATION_TIMEOUT_MS } from "./helpers/git-integration-timeout.js";

/** Temp roots created by this suite, removed reliably in `afterEach`. */
const tempRoots: string[] = [];

/** Create and track a fresh disposable temp root. */
async function tempRoot(prefix = "batch-candidate-test-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

/**
 * Remove one tracked temp root with bounded retries: a just-exited Git child
 * can briefly hold handles on Windows. Exhausted retries surface the failure
 * rather than leaking the directory.
 */
async function removeRoot(root: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 9) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
  throw lastError;
}

afterEach(async () => {
  const roots = tempRoots.splice(0);
  for (const root of roots) {
    await removeRoot(root);
  }
});

const execFileP = promisify(execFile);

/** Independent Git inspection: real `git` outside the code under test. */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd, windowsHide: true });
  return stdout;
}

/** The five-role models block supplied to `prepareCandidate`. */
const candidateModels: ModelRoles = {
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

const candidateConfig: CandidateFactoryConfig = {
  models: candidateModels,
  requireCleanWorkingTree: true,
};

/**
 * Generate a minimal valid case directory (definition, readable assertion
 * placeholder, fixture files) and return its validated case entry, using
 * `validateBatchManifest` purely as the setup input boundary.
 */
async function createValidatedCase(
  root: string,
  caseId: string,
  fixtureFiles: ReadonlyArray<readonly [string, string]>,
): Promise<ValidatedBatchCase> {
  const caseDirectory = join(root, "cases", caseId);
  const fixtureDirectory = join(caseDirectory, "fixture");
  await mkdir(fixtureDirectory, { recursive: true });
  for (const [relativePath, content] of fixtureFiles) {
    const filePath = join(fixtureDirectory, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
  await writeFile(
    join(caseDirectory, "definition.json"),
    JSON.stringify({
      id: caseId,
      schemaVersion: "v1",
      kind: "solvable",
      category: "refactor",
      objective: "Refactor the fixture module without changing its behavior",
      expectedTerminalOutcome: "ACCEPTED",
      humanImplementationInterventionAllowed: false,
      assertionIdentifiers: ["assert-terminal-status"],
    }),
  );
  // Readable placeholder only; never imported or executed by this suite.
  await writeFile(join(caseDirectory, "assert.ts"), "export {};\n");

  const input = await validateBatchManifest(
    {
      schemaVersion: "v1",
      factoryVersionRef: "pi-software-factory@candidate-tests",
      cases: [{ caseDirectory: `cases/${caseId}`, humanImplementationIntervention: false }],
    },
    root,
  );
  return input.cases[0];
}

/** Prepare one candidate under a fresh `<root>/out/<caseId>` output directory. */
async function prepareCase(validatedCase: ValidatedBatchCase, root: string) {
  const outputParent = join(root, "out");
  await mkdir(outputParent, { recursive: true });
  const caseOutputDirectory = join(outputParent, validatedCase.caseId);
  const prepared = await prepareCandidate({
    validatedCase,
    caseOutputDirectory,
    candidateConfig,
    runner: createProductionProcessRunner(),
  });
  return { caseOutputDirectory, prepared };
}

it("prepareCandidate prepares a fresh candidate repository with exactly one baseline commit", async () => {
  const root = await tempRoot();
  const validatedCase = await createValidatedCase(root, "candidate-case-1", [
    ["readme.md", "hello\n"],
  ]);
  const { caseOutputDirectory, prepared } = await prepareCase(validatedCase, root);

  expect(prepared.candidateRoot).toBe(join(caseOutputDirectory, "candidate"));
  expect(existsSync(join(prepared.candidateRoot, ".git"))).toBe(true);
  expect(prepared.baselineCommit).toMatch(/^[0-9a-f]{40}$/);
  expect((await git(prepared.candidateRoot, ["rev-parse", "HEAD"])).trim()).toBe(
    prepared.baselineCommit,
  );
  expect((await git(prepared.candidateRoot, ["rev-list", "--count", "HEAD"])).trim()).toBe("1");
}, GIT_INTEGRATION_TIMEOUT_MS);

it("prepareCandidate leaves a clean working tree with /.pi/ excluded from the candidate repository", async () => {
  const root = await tempRoot();
  const validatedCase = await createValidatedCase(root, "candidate-case-2", [
    ["readme.md", "hello\n"],
  ]);
  const { prepared } = await prepareCase(validatedCase, root);

  const status = await git(prepared.candidateRoot, ["status", "--porcelain", "--untracked-files=all"]);
  expect(status).toBe("");

  const exclude = readFileSync(join(prepared.candidateRoot, ".git", "info", "exclude"), "utf8");
  expect(exclude.split(/\r?\n/)).toContain("/.pi/");
}, GIT_INTEGRATION_TIMEOUT_MS);

it("prepareCandidate commits the fixture files while keeping .pi/software-factory.json out of the baseline commit", async () => {
  const root = await tempRoot();
  const rootFileContent = "root fixture file\n";
  const nestedFileContent = "nested fixture file\n";
  const validatedCase = await createValidatedCase(root, "candidate-case-3", [
    ["notes.txt", rootFileContent],
    ["nested/deep/inner.txt", nestedFileContent],
  ]);
  const { prepared } = await prepareCase(validatedCase, root);

  const listing = (
    await git(prepared.candidateRoot, ["ls-tree", "-r", "--name-only", prepared.baselineCommit])
  )
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  expect([...listing].sort()).toEqual(["nested/deep/inner.txt", "notes.txt"]);

  expect(await git(prepared.candidateRoot, ["show", `${prepared.baselineCommit}:notes.txt`])).toBe(
    rootFileContent,
  );
  expect(
    await git(prepared.candidateRoot, ["show", `${prepared.baselineCommit}:nested/deep/inner.txt`]),
  ).toBe(nestedFileContent);

  const configPath = join(prepared.candidateRoot, ".pi", "software-factory.json");
  expect(existsSync(configPath)).toBe(true);
  const parsed = JSON.parse(readFileSync(configPath, "utf8"));
  expect(Object.keys(parsed).sort()).toEqual(["models", "requireCleanWorkingTree"]);
  expect(parsed).toEqual({ models: candidateModels, requireCleanWorkingTree: true });
}, GIT_INTEGRATION_TIMEOUT_MS);

it("prepareCandidate rejects a pre-existing per-case output directory without reusing it", async () => {
  const root = await tempRoot();
  const validatedCase = await createValidatedCase(root, "candidate-case-4", [
    ["readme.md", "hello\n"],
  ]);
  const caseOutputDirectory = join(root, "out", validatedCase.caseId);
  await mkdir(caseOutputDirectory, { recursive: true });
  const sentinelPath = join(caseOutputDirectory, "sentinel.txt");
  await writeFile(sentinelPath, "sentinel\n");

  await expect(
    prepareCandidate({
      validatedCase,
      caseOutputDirectory,
      candidateConfig,
      runner: createProductionProcessRunner(),
    }),
  ).rejects.toThrowError(
    /already exists; the batch requires a fresh candidate and never reopens a prior run/,
  );

  expect(await readFile(sentinelPath, "utf8")).toBe("sentinel\n");
  expect(existsSync(join(caseOutputDirectory, "candidate"))).toBe(false);
  expect(await readdir(caseOutputDirectory)).toEqual(["sentinel.txt"]);
}, GIT_INTEGRATION_TIMEOUT_MS);
