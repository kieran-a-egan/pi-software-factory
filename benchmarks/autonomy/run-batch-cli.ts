/**
 * Sequential, fail-stop autonomy batch CLI (foundation contracts).
 *
 * This module prepares isolated Git candidates, invokes Pi and assertions
 * once through an injectable process boundary, and preserves execution
 * evidence. All observation/scoring semantics are delegated to the existing
 * benchmark modules (`validate.js`, `run-artifacts.js`, `score.js`); nothing
 * here re-implements validation, ingestion, or scoring rules.
 *
 * This file currently carries the foundation layer of the batch:
 *
 *   1. typed process request/result and dependency-injection contracts
 *      (`ProcessRequest`, `ProcessResult`, `ProcessRunner`) suitable for
 *      scripting Pi/assert launches in tests; importing this module starts
 *      no subprocesses;
 *   2. strict CLI parsing (exactly `--input`, `--output`, `--factory-config`)
 *      and strict manifest validation: exact object keys, `schemaVersion`
 *      "v1", a caller-supplied `pi-software-factory@` reference with a
 *      nonempty suffix, `caseDirectory` strings, explicit intervention
 *      booleans, readable `definition.json`/`assert.ts` files, a `fixture`
 *      directory, duplicate and Windows-colliding case ids, and a projected
 *      models configuration — all checked before any subprocess launches;
 *   3. fresh-output enforcement: an existing output path (file, directory,
 *      or dangling symlink) is rejected, and the output leaf is claimed with
 *      a nonrecursive exclusive `mkdir` so a check/create race cannot reopen
 *      an existing batch;
 *   4. candidate preparation: fixture contents are copied into a fresh
 *      candidate root, an isolated Git repository is initialized, `/.pi/` is
 *      excluded through `.git/info/exclude`, exactly one baseline commit is
 *      created with a command-local identity and disabled commit signing,
 *      and an initially clean working tree is required;
 *   5. the cross-platform production process adapter (`shell: false`,
 *      argument arrays, closed stdin, drained stdout/stderr, captured launch
 *      failures) plus the Pi and assertion request builders.
 *
 * Per-case sequential execution composes the existing benchmark modules:
 * each manifest case prepares a fresh candidate, launches Pi exactly once
 * with `/factory <objective>` on stdin, requires exactly one run directory
 * under `candidate/.pi/software-factory/runs`, launches the case's
 * `assert.ts` exactly once, then delegates ingestion to
 * `ingestRunArtifacts` and scoring to `scoreCase` / `scoreAggregate`.
 * Terminal outcomes (HUMAN/FAILED/BLOCKED), failed assertion results,
 * nonzero assertion exits with usable declared results, and
 * `passed: false` scores are benchmark evidence — never retry triggers.
 * Infrastructure failures (launch failures, unusable process completions,
 * zero/multiple run directories, invalid artifacts, malformed assertion
 * JSON, binding errors, persistence errors) stop the batch immediately, leave
 * prior completed observation files intact, and record the failed case,
 * phase, and error in `batch-state.json` where writable.
 *
 * Output layout (every artifact is new; only `batch-state.json` is rewritten,
 * as the live summary owned by this invocation):
 *
 *   <output>/
 *     validated-manifest.json   the validated manifest, preserved unchanged
 *     provenance.json           input/config paths, projected candidate
 *                               config, ordered validated definitions,
 *                               resolved case paths, case order
 *     batch-state.json          live summary: ordered case entries, phases,
 *                               candidate/baseline/run identity, completed
 *                               observation paths, actionable failure details
 *     aggregate-input.json      {"definitions": [...], "executionRecords": [...]}
 *                               in manifest order (the exact
 *                               bench:score-aggregate envelope)
 *     aggregate-score.json      the final aggregate score
 *     <case-id>/
 *       candidate/              fresh candidate root
 *       pi.stdout.txt, pi.stderr.txt, pi-process-result.json
 *       assertion.stdout.txt, assertion.stderr.txt,
 *       assertion-process-result.json
 *       execution-record.json   the ingested execution record
 *       case-score.json         the deterministic case score
 *
 * Manifest shape (exact; unknown keys are rejected):
 *
 *   {
 *     "schemaVersion": "v1",
 *     "factoryVersionRef": "pi-software-factory@<ref>",
 *     "cases": [
 *       { "caseDirectory": "<relative to the manifest directory>",
 *         "humanImplementationIntervention": false }
 *     ]
 *   }
 *
 * `caseDirectory` values resolve against the manifest file's directory (not
 * the process cwd). Each case directory must contain `definition.json`
 * (validated with the existing {@link validateBenchmarkCaseDefinition}),
 * `assert.ts`, and a `fixture` directory. Manifest order and the explicit
 * provenance/intervention values are preserved unchanged; no corpus
 * discovery is performed. The `--factory-config` input contributes only its
 * explicitly supplied `models` block (projected through the existing
 * {@link resolveConfig} boundary with `requireCleanWorkingTree: true`); no
 * other host configuration is copied into candidates.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, lstatSync, readFileSync, statSync, writeFileSync, type Stats } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BENCHMARK_SCHEMA_VERSION,
  type BenchmarkAggregateScore,
  type BenchmarkAssertionResult,
  type BenchmarkCaseDefinition,
  type BenchmarkCaseScore,
  type BenchmarkExecutionRecord,
} from "./types.js";
import { validateBenchmarkCaseDefinition } from "./validate.js";
import { ingestRunArtifacts } from "./run-artifacts.js";
import { scoreAggregate, scoreCase } from "./score.js";
import { resolveConfig } from "../../src/config.js";
import type { ModelRoles } from "../../src/types.js";

const require = createRequire(import.meta.url);

/* -------------------------------------------------------------------------- */
/* Process boundary contracts                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One process launch request. `args` is always an explicit argument array
 * (never a shell-interpolated command line), `cwd` is the working directory,
 * and `stdin` is optional exact input text written to the child's stdin
 * before it is closed.
 */
export interface ProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  stdin?: string;
}

/**
 * The observed outcome of one process launch. `stdout`/`stderr` are the
 * fully drained streams; `exitCode`/`signal` describe termination.
 * `launchError` is present when the process failed to launch and is the
 * authoritative signal in that case (partial output is retained; `exitCode`
 * is `null` on POSIX and a platform libuv error code such as `-4058` on
 * Windows).
 */
export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  launchError?: string;
}

/**
 * The injectable process boundary used for Pi, assertion, and candidate Git
 * launches. Tests script this seam while exercising real filesystem
 * persistence; production uses {@link createProductionProcessRunner}.
 */
export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

/* -------------------------------------------------------------------------- */
/* CLI and runner contracts                                                   */
/* -------------------------------------------------------------------------- */

/** The three strictly parsed CLI inputs. */
export interface BatchRunOptions {
  /** Path to the batch manifest JSON file. */
  input: string;
  /** Path of the fresh batch output root (must not already exist). */
  output: string;
  /** Path to the caller-supplied factory config JSON file. */
  factoryConfig: string;
}

/** Dependency-injection seam for {@link runBatch}; `runner` defaults to the production process adapter. */
export interface RunBatchDependencies {
  runner?: ProcessRunner;
}

/* -------------------------------------------------------------------------- */
/* Manifest contracts                                                         */
/* -------------------------------------------------------------------------- */

/** One manifest case entry (exact keys; no other fields). */
export interface BatchManifestCaseEntry {
  caseDirectory: string;
  humanImplementationIntervention: boolean;
}

/** The exact batch manifest shape. */
export interface BatchManifest {
  schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  factoryVersionRef: string;
  cases: BatchManifestCaseEntry[];
}

/** One fully prevalidated batch case, in manifest order. */
export interface ValidatedBatchCase {
  /** The validated definition id; keys the per-case output directory. */
  caseId: string;
  /** Resolved absolute case directory (resolved against the manifest directory). */
  caseDirectory: string;
  /** Resolved absolute `definition.json` path. */
  definitionPath: string;
  /** Resolved absolute `assert.ts` path. */
  assertionPath: string;
  /** Resolved absolute `fixture` directory. */
  fixtureDirectory: string;
  /** The definition validated with the existing benchmark validator. */
  definition: BenchmarkCaseDefinition;
  /** The manifest's explicit intervention boolean, preserved unchanged. */
  humanImplementationIntervention: boolean;
}

/** The fully prevalidated batch input, in manifest order. */
export interface ValidatedBatchInput {
  schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  /** Opaque caller provenance, preserved byte-for-byte. */
  factoryVersionRef: string;
  /** Absolute directory containing the manifest file. */
  manifestDirectory: string;
  cases: ValidatedBatchCase[];
}

/**
 * The exact configuration persisted into each candidate's
 * `.pi/software-factory.json`: only the validated models block plus the
 * forced clean-tree gate. No other host configuration is carried.
 */
export interface CandidateFactoryConfig {
  models: ModelRoles;
  requireCleanWorkingTree: true;
}

/** The result of preparing one fresh candidate root. */
export interface PreparedCandidate {
  /** Absolute candidate root (the candidate fixture directory). */
  candidateRoot: string;
  /** SHA of the single baseline commit. */
  baselineCommit: string;
}

/* -------------------------------------------------------------------------- */
/* Small shared helpers (fail-closed, no coercion)                            */
/* -------------------------------------------------------------------------- */

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  return describeType(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${name} must be an object, got ${describeType(value)}`);
  return value;
}

/** Reject any keys beyond the exact allowed set (unknown keys are errors). */
function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const unknownKeys = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `${name} must contain exactly the keys ${allowed.map((key) => JSON.stringify(key)).join(", ")}, ` +
        `found unknown key(s): ${unknownKeys.map((key) => JSON.stringify(key)).join(", ")}`,
    );
  }
}

/** Normalize a message to one line (embedded line breaks become spaces). */
function oneLine(value: string): string {
  return value.replace(/\s*[\r\n\u2028\u2029]\s*/g, " ").trim();
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === undefined ? error.message : `${error.message} (${code})`;
  }
  return String(error);
}

/**
 * Read one caller-supplied input file and parse it as JSON, contextualizing
 * read/parse failures with the input role and path. The parsed value is
 * untrusted and is validated by the caller.
 */
async function readJsonFile(filePath: string, role: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`${role} file ${filePath}: missing or unreadable (${describeError(error)})`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${role} file ${filePath}: malformed JSON (${describeError(error)})`);
  }
}

function statPath(path: string): Stats {
  try {
    return statSync(path);
  } catch (error) {
    throw new Error(`${path}: missing or inaccessible (${describeError(error)})`);
  }
}

function requirePathIsDirectory(path: string, role: string): void {
  if (!statPath(path).isDirectory()) throw new Error(`${role} ${path}: not a directory`);
}

function requirePathIsFile(path: string, role: string): void {
  if (!statPath(path).isFile()) throw new Error(`${role} ${path}: not a readable file`);
}

/* -------------------------------------------------------------------------- */
/* Strict CLI parsing                                                         */
/* -------------------------------------------------------------------------- */

const CLI_FLAGS = ["--input", "--output", "--factory-config"] as const;
type CliFlag = (typeof CLI_FLAGS)[number];

const USAGE = [
  "Usage:",
  "  npm run --silent bench:run-batch --",
  '    --input <manifest.json> \\  (batch manifest: {"schemaVersion": "v1", "factoryVersionRef": "pi-software-factory@<ref>", "cases": [...]})',
  "    --output <directory> \\  (fresh batch output root; must not already exist)",
  "    --factory-config <file>  (JSON factory config with an explicit models block)",
].join("\n");

/**
 * Strictly parse the CLI flags: exactly the three required flags, each with a
 * value, in any order. Unknown options, positional arguments, duplicate
 * options, and missing values are errors. Nothing is defaulted.
 */
export function parseBatchCliArgs(argv: string[]): BatchRunOptions {
  const values: Partial<Record<CliFlag, string>> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!CLI_FLAGS.includes(token as CliFlag)) {
      const kind = token.startsWith("--") ? "unknown option" : "unexpected positional argument";
      throw new Error(`${kind} ${JSON.stringify(token)}; ${USAGE}`);
    }
    const flag = token as CliFlag;
    if (values[flag] !== undefined) {
      throw new Error(`duplicate option ${flag}; ${USAGE}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${flag}; ${USAGE}`);
    }
    values[flag] = value;
    i += 1;
  }
  const missing = CLI_FLAGS.filter((flag) => values[flag] === undefined);
  if (missing.length > 0) {
    throw new Error(`missing required flag(s): ${missing.join(", ")}; ${USAGE}`);
  }
  return {
    input: values["--input"] as string,
    output: values["--output"] as string,
    factoryConfig: values["--factory-config"] as string,
  };
}

/* -------------------------------------------------------------------------- */
/* Strict manifest validation (pre-subprocess)                                */
/* -------------------------------------------------------------------------- */

/** Exact top-level manifest keys. */
const MANIFEST_KEYS = ["schemaVersion", "factoryVersionRef", "cases"] as const;

/** Exact manifest case-entry keys. */
const CASE_ENTRY_KEYS = ["caseDirectory", "humanImplementationIntervention"] as const;

/**
 * Caller-supplied provenance reference: opaque, preserved byte-for-byte.
 * Only the required `pi-software-factory@` prefix and a nonempty suffix are
 * checked; the reference is never resolved against Git or the installed
 * package.
 */
const FACTORY_VERSION_REF_PATTERN = /^pi-software-factory@.+/;

/** Windows reserved device names (case-folded) that cannot key directories. */
const WINDOWS_RESERVED_DEVICE_NAMES = new Set<string>([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * Require that a validated case id can safely key a per-case output
 * directory directly under the output root: nonempty, no path separators,
 * not `.`/`..`, and not a Windows reserved device name (with Windows' case
 * folding and trailing dot/space normalization applied).
 */
export function validateCaseIdForOutputDirectory(caseId: string): void {
  if (typeof caseId !== "string" || caseId.length === 0) {
    throw new Error("case id must be a nonempty string");
  }
  if (caseId.includes("/") || caseId.includes("\\")) {
    throw new Error(`case id ${JSON.stringify(caseId)} must not contain path separators`);
  }
  if (caseId === "." || caseId === "..") {
    throw new Error(`case id ${JSON.stringify(caseId)} must not be a relative path segment`);
  }
  const normalized = caseId.replace(/[.\s]+$/g, "").toLowerCase();
  const baseName = normalized.split(".")[0];
  if (WINDOWS_RESERVED_DEVICE_NAMES.has(normalized) || WINDOWS_RESERVED_DEVICE_NAMES.has(baseName)) {
    throw new Error(`case id ${JSON.stringify(caseId)} is a reserved Windows device name`);
  }
}

/**
 * Reject fixture directories carrying inherited runtime/repository state. A
 * top-level `.git` or `.pi` entry (including a dangling symlink) means the
 * fixture is contaminated; the batch refuses to copy it rather than silently
 * excluding contents or overwriting a previous run's state.
 */
function rejectContaminatedFixtureState(fixtureDirectory: string): void {
  for (const entry of [".git", ".pi"] as const) {
    let stats: Stats;
    try {
      stats = lstatSync(join(fixtureDirectory, entry));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw new Error(`${fixtureDirectory}/${entry}: inaccessible (${describeError(error)})`);
    }
    const kind = stats.isSymbolicLink() ? "symlink" : stats.isDirectory() ? "directory" : "file";
    throw new Error(
      `fixture ${fixtureDirectory}: contains inherited ${entry} state (${kind}); ` +
        "remove it from the fixture before running the batch",
    );
  }
}

/**
 * Strictly validate the batch manifest and every case it references. All
 * checks complete before any subprocess launches:
 *
 *  - exact top-level and case-entry keys; `schemaVersion` exactly "v1";
 *  - `factoryVersionRef` matches `pi-software-factory@<nonempty suffix>` and
 *    is preserved byte-for-byte (never resolved against Git);
 *  - `cases` is a nonempty array of `{caseDirectory, humanImplementationIntervention}`;
 *  - each `caseDirectory` resolves against `manifestDirectory` (not the
 *    process cwd) and contains a readable `definition.json` (validated with
 *    the existing {@link validateBenchmarkCaseDefinition}), a readable
 *    `assert.ts`, and a `fixture` directory without inherited `.git`/`.pi`
 *    state;
 *  - case ids are unique (exact) and unique case-insensitively (Windows
 *    output-directory collision), and each can key an output directory.
 *
 * Manifest order and the explicit provenance/intervention values are
 * preserved unchanged. No corpus discovery is performed.
 */
export async function validateBatchManifest(value: unknown, manifestDirectory: string): Promise<ValidatedBatchInput> {
  const manifest = requireRecord(value, "manifest");
  requireExactKeys(manifest, MANIFEST_KEYS, "manifest");

  if (manifest.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    throw new Error(
      `manifest schemaVersion must be exactly ${JSON.stringify(BENCHMARK_SCHEMA_VERSION)}, ` +
        `got ${describeValue(manifest.schemaVersion)}`,
    );
  }
  const factoryVersionRef = manifest.factoryVersionRef;
  if (typeof factoryVersionRef !== "string" || !FACTORY_VERSION_REF_PATTERN.test(factoryVersionRef)) {
    throw new Error(
      `manifest factoryVersionRef must be a string of the form "pi-software-factory@<ref>" ` +
        `with a nonempty suffix, got ${describeValue(factoryVersionRef)}`,
    );
  }
  const entries = manifest.cases;
  if (!Array.isArray(entries)) {
    throw new Error(`manifest cases must be an array, got ${describeType(entries)}`);
  }
  if (entries.length === 0) {
    throw new Error("manifest cases must contain at least one case");
  }

  const cases: ValidatedBatchCase[] = [];
  const seenIds = new Map<string, string>();
  for (let i = 0; i < entries.length; i += 1) {
    const name = `manifest cases[${i}]`;
    const entry = requireRecord(entries[i], name);
    requireExactKeys(entry, CASE_ENTRY_KEYS, name);

    const caseDirectory = entry.caseDirectory;
    if (typeof caseDirectory !== "string" || caseDirectory.length === 0) {
      throw new Error(`${name}.caseDirectory must be a nonempty string, got ${describeValue(caseDirectory)}`);
    }
    const intervention = entry.humanImplementationIntervention;
    if (typeof intervention !== "boolean") {
      throw new Error(
        `${name}.humanImplementationIntervention must be a boolean, got ${describeValue(intervention)}`,
      );
    }

    const resolvedCaseDirectory = resolve(manifestDirectory, caseDirectory);
    const definitionPath = join(resolvedCaseDirectory, "definition.json");
    const assertionPath = join(resolvedCaseDirectory, "assert.ts");
    const fixtureDirectory = join(resolvedCaseDirectory, "fixture");

    requirePathIsFile(definitionPath, "case definition");
    requirePathIsFile(assertionPath, "case assertion");
    requirePathIsDirectory(fixtureDirectory, "case fixture");
    rejectContaminatedFixtureState(fixtureDirectory);

    const definition = validateBenchmarkCaseDefinition(
      await readJsonFile(definitionPath, `case ${name} definition`),
    );
    const caseId = definition.id;
    validateCaseIdForOutputDirectory(caseId);
    const collisionKey = caseId.toLowerCase();
    const existingId = seenIds.get(collisionKey);
    if (existingId !== undefined) {
      throw new Error(
        existingId === caseId
          ? `manifest case id ${JSON.stringify(caseId)} is declared more than once`
          : `manifest case ids ${JSON.stringify(existingId)} and ${JSON.stringify(caseId)} collide ` +
            "case-insensitively (their Windows output directories would be identical)",
      );
    }
    seenIds.set(collisionKey, caseId);

    cases.push({
      caseId,
      caseDirectory: resolvedCaseDirectory,
      definitionPath,
      assertionPath,
      fixtureDirectory,
      definition,
      humanImplementationIntervention: intervention,
    });
  }

  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    factoryVersionRef,
    manifestDirectory,
    cases,
  };
}

/**
 * Resolve the per-case output directory for one case id directly under the
 * output root, rejecting ids that cannot key a safe directory (see
 * {@link validateCaseIdForOutputDirectory}) and any path that would escape
 * the root.
 */
export function caseOutputDirectory(outputRoot: string, caseId: string): string {
  validateCaseIdForOutputDirectory(caseId);
  const root = resolve(outputRoot);
  const directory = join(root, caseId);
  if (relative(root, directory) !== caseId) {
    throw new Error(`case id ${JSON.stringify(caseId)} escapes the output root ${root}`);
  }
  return directory;
}

/**
 * Project the caller-supplied factory config down to the only fields a
 * candidate receives: its explicit `models` block, validated through the
 * existing {@link resolveConfig} boundary with `requireCleanWorkingTree`
 * forced true. No other host configuration (verification commands, run
 * roots, ...) is carried into candidates.
 */
export function validateFactoryConfigModels(parsed: unknown, configPath: string): CandidateFactoryConfig {
  const config = requireRecord(parsed, "factory config");
  if (!Object.prototype.hasOwnProperty.call(config, "models")) {
    throw new Error(`factory config ${configPath}: missing explicit "models" block`);
  }
  try {
    const resolved = resolveConfig(process.cwd(), { models: config.models, requireCleanWorkingTree: true });
    return { models: resolved.models, requireCleanWorkingTree: true };
  } catch (error) {
    throw new Error(`factory config ${configPath}: invalid models block (${describeError(error)})`);
  }
}

/* -------------------------------------------------------------------------- */
/* Fresh-output enforcement                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Require that the batch output path does not exist yet. Files, directories,
 * and symlinks (including dangling ones) are all rejections: the batch never
 * reopens, overwrites, or resumes an existing output.
 */
export function validateFreshOutputPath(outputPath: string): void {
  let stats: Stats;
  try {
    stats = lstatSync(outputPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw new Error(`output path ${outputPath}: inaccessible (${describeError(error)})`);
  }
  const kind = stats.isSymbolicLink() ? "symlink" : stats.isDirectory() ? "directory" : "file";
  throw new Error(`output path ${outputPath} already exists (${kind}); the batch requires a fresh output directory`);
}

/**
 * Claim the output leaf directory exclusively. The parent chain is created
 * recursively, then the leaf with a nonrecursive `mkdir` so a concurrent
 * invocation racing between validation and creation gets `EEXIST` and fails
 * instead of reopening an existing batch.
 */
export async function claimOutputDirectory(outputPath: string): Promise<void> {
  const parent = dirname(outputPath);
  try {
    await mkdir(parent, { recursive: true });
  } catch (error) {
    throw new Error(`output path ${outputPath}: cannot create parent directory ${parent} (${describeError(error)})`);
  }
  try {
    await mkdir(outputPath, { recursive: false });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new Error(
        `output path ${outputPath} was claimed by a concurrent invocation; refusing to reopen an existing batch`,
      );
    }
    throw new Error(`output path ${outputPath}: cannot create output directory (${describeError(error)})`);
  }
}

/* -------------------------------------------------------------------------- */
/* Executable and loader resolution (no subprocesses)                         */
/* -------------------------------------------------------------------------- */

/** The installed Pi package whose `pi` bin is a JavaScript entry. */
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_BIN_NAME = "pi";

/**
 * Resolve the installed Pi package's `pi` bin as an absolute JavaScript
 * entry path to launch with `process.execPath` (never a Windows `.cmd` shim,
 * so `shell: false` works on both platforms). Resolution walks up from this
 * module's directory through `node_modules` roots and performs no
 * subprocesses.
 */
export function resolvePiEntryPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  let directory = moduleDirectory;
  for (;;) {
    const packageDirectory = join(directory, "node_modules", PI_PACKAGE_NAME);
    let packageJson: unknown = undefined;
    try {
      packageJson = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        // No package here; keep walking up.
      } else {
        throw new Error(
          `Pi package ${PI_PACKAGE_NAME} at ${packageDirectory}: unreadable package.json (${describeError(error)})`,
        );
      }
    }
    if (packageJson !== undefined) {
      const record = isPlainRecord(packageJson) ? packageJson : {};
      const bin = record["bin"];
      const binPath = typeof bin === "string" ? bin : isPlainRecord(bin) ? bin[PI_BIN_NAME] : undefined;
      if (typeof binPath === "string" && binPath.length > 0) {
        const entryPath = resolve(packageDirectory, binPath);
        try {
          statSync(entryPath);
        } catch (error) {
          throw new Error(`Pi package ${PI_PACKAGE_NAME} bin entry ${entryPath} is missing (${describeError(error)})`);
        }
        return entryPath;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(
    `installed Pi package ${PI_PACKAGE_NAME} with a "${PI_BIN_NAME}" bin entry was not found in any ` +
      `node_modules root above ${moduleDirectory}`,
  );
}

/**
 * Resolve this repository's installed `tsx` loader to an absolute module URL
 * for `node --import`, so assertions run with the same toolchain as the
 * `bench:*` scripts. No subprocesses are started.
 */
export function resolveTsxLoaderUrl(): string {
  let loaderPath: string;
  try {
    loaderPath = require.resolve("tsx");
  } catch (error) {
    throw new Error(
      `installed tsx loader was not resolved from ${dirname(fileURLToPath(import.meta.url))} (${describeError(error)})`,
    );
  }
  return pathToFileURL(loaderPath).href;
}

/* -------------------------------------------------------------------------- */
/* Process request builders                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build the Pi launch request for one candidate: the installed `pi`
 * JavaScript bin via `process.execPath` (equivalent to the installed `pi`
 * command), the required non-interactive flags, and the exact prompt
 * `/factory <objective>` supplied through stdin — never through a shell,
 * with no trimming, escaping, or appended text.
 */
export function buildPiProcessRequest(candidateRoot: string, objective: string): ProcessRequest {
  return {
    executable: process.execPath,
    args: [resolvePiEntryPath(), "--approve", "--no-session", "-p"],
    cwd: candidateRoot,
    stdin: `/factory ${objective}`,
  };
}

/**
 * Build the assertion launch request: `node --import <tsx-loader>
 * <absolute assert.ts> <absolute candidate root>` using the repository's
 * installed Node/tsx toolchain. The candidate root is the single explicit
 * candidate argument the corpus `assert.ts` contract expects.
 */
export function buildAssertionProcessRequest(assertionPath: string, candidateRoot: string): ProcessRequest {
  return {
    executable: process.execPath,
    args: ["--import", resolveTsxLoaderUrl(), resolve(assertionPath), resolve(candidateRoot)],
    cwd: candidateRoot,
  };
}

/* -------------------------------------------------------------------------- */
/* Production process adapter                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The production {@link ProcessRunner}: `spawn` with `shell: false` and
 * explicit argument arrays, piped stdio. Stdin is written (when provided)
 * and always closed; stdout/stderr are drained as UTF-8 strings; launch
 * failures are captured as `launchError` without losing partial output.
 */
export function createProductionProcessRunner(): ProcessRunner {
  return async (request) => {
    let child: ChildProcess;
    try {
      child = spawn(request.executable, request.args, {
        cwd: request.cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      return { stdout: "", stderr: "", exitCode: null, signal: null, launchError: describeError(error) };
    }

    let stdout = "";
    let stderr = "";
    let launchError: string | undefined;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: Error) => {
      launchError = describeError(error);
    });
    if (child.stdin !== null) {
      if (request.stdin !== undefined) {
        child.stdin.write(request.stdin);
      }
      child.stdin.end();
    }

    const { exitCode, signal } = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolveClose) => {
        child.on("close", (code, sig) => {
          resolveClose({ exitCode: code, signal: sig });
        });
      },
    );
    return { stdout, stderr, exitCode, signal, ...(launchError === undefined ? {} : { launchError }) };
  };
}

/* -------------------------------------------------------------------------- */
/* Candidate preparation                                                      */
/* -------------------------------------------------------------------------- */

/** Command-local Git identity and disabled commit signing for baseline commits. */
const GIT_IDENTITY_ARGS = [
  "-c",
  "user.name=pi-software-factory bench",
  "-c",
  "user.email=bench@pi-software-factory.local",
  "-c",
  "commit.gpgsign=false",
] as const;

/** The runtime-state exclusion line written to `.git/info/exclude`. */
const GIT_INFO_EXCLUDE_LINE = "/.pi/";

/** Run one Git command through the injected runner; any failure is an error carrying its output. */
async function runGit(runner: ProcessRunner, cwd: string, args: readonly string[]): Promise<ProcessResult> {
  const result = await runner({ executable: "git", args: [...args], cwd });
  if (result.launchError !== undefined) {
    throw new Error(`git ${args[0]} failed to launch in ${cwd} (${result.launchError})`);
  }
  if (result.exitCode !== 0) {
    const detail = oneLine(result.stderr) || oneLine(result.stdout);
    const termination = result.exitCode === null ? `signal ${result.signal ?? "unknown"}` : `exit ${result.exitCode}`;
    throw new Error(`git ${args.join(" ")} failed in ${cwd} (${termination})${detail === "" ? "" : `: ${detail}`}`);
  }
  return result;
}

/**
 * Ensure `<candidate>/.git/info/exclude` excludes `/.pi/` so Factory runtime
 * state is invisible to the candidate's Git status. Idempotent.
 */
async function writeGitInfoExclude(candidateRoot: string): Promise<void> {
  const infoDirectory = join(candidateRoot, ".git", "info");
  await mkdir(infoDirectory, { recursive: true });
  const excludePath = join(infoDirectory, "exclude");
  let existing: string;
  try {
    existing = readFileSync(excludePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw new Error(`${excludePath}: unreadable (${describeError(error)})`);
    existing = "";
  }
  const lines = existing === "" ? [] : existing.split(/\r?\n/);
  if (!lines.some((line) => line.trim() === GIT_INFO_EXCLUDE_LINE)) {
    const prefix = existing === "" ? "" : existing.endsWith("\n") ? existing : `${existing}\n`;
    writeFileSync(excludePath, `${prefix}${GIT_INFO_EXCLUDE_LINE}\n`, "utf8");
  }
}

/** Parameters for {@link prepareCandidate}. */
export interface PrepareCandidateParams {
  validatedCase: ValidatedBatchCase;
  caseOutputDirectory: string;
  candidateConfig: CandidateFactoryConfig;
  runner: ProcessRunner;
}

/**
 * Prepare one fresh candidate root at `<caseOutputDirectory>/candidate`:
 *
 *  1. create the per-case output directory and candidate root (both
 *     nonrecursive; an existing path is a not-fresh error — the batch never
 *     reopens a prior run);
 *  2. copy the validated fixture contents into the candidate root;
 *  3. initialize an isolated Git repository;
 *  4. exclude `/.pi/` through `.git/info/exclude`;
 *  5. write the candidate `.pi/software-factory.json` containing only the
 *     validated models block plus forced `requireCleanWorkingTree: true`;
 *  6. stage everything and create exactly one baseline commit with a
 *     command-local identity and disabled commit signing;
 *  7. require an initially clean working tree (`git status --porcelain
 *     --untracked-files=all` is empty) and report the baseline SHA.
 */
export async function prepareCandidate(params: PrepareCandidateParams): Promise<PreparedCandidate> {
  const { validatedCase, caseOutputDirectory, candidateConfig, runner } = params;
  const caseId = validatedCase.caseId;
  const candidateRoot = join(caseOutputDirectory, "candidate");

  let caseDirectoryCreated = false;
  try {
    await mkdir(caseOutputDirectory, { recursive: false });
    caseDirectoryCreated = true;
    await mkdir(candidateRoot, { recursive: false });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const target = caseDirectoryCreated ? candidateRoot : caseOutputDirectory;
    if (code === "EEXIST") {
      throw new Error(`${target} already exists; the batch requires a fresh candidate and never reopens a prior run`);
    }
    throw new Error(`${target}: cannot create directory (${describeError(error)})`);
  }

  cpSync(validatedCase.fixtureDirectory, candidateRoot, { recursive: true });
  await runGit(runner, candidateRoot, ["init"]);
  await writeGitInfoExclude(candidateRoot);

  const piDirectory = join(candidateRoot, ".pi");
  await mkdir(piDirectory, { recursive: true });
  writeFileSync(
    join(piDirectory, "software-factory.json"),
    `${JSON.stringify({ models: candidateConfig.models, requireCleanWorkingTree: true }, null, 2)}\n`,
    "utf8",
  );

  await runGit(runner, candidateRoot, ["add", "-A"]);
  await runGit(runner, candidateRoot, [...GIT_IDENTITY_ARGS, "commit", "-m", `bench:run-batch baseline ${caseId}`]);

  const status = await runGit(runner, candidateRoot, ["status", "--porcelain", "--untracked-files=all"]);
  if (status.stdout !== "") {
    throw new Error(`candidate ${candidateRoot} working tree is not clean after the baseline commit:\n${status.stdout}`);
  }

  const head = await runGit(runner, candidateRoot, ["rev-parse", "HEAD"]);
  const baselineCommit = head.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(baselineCommit)) {
    throw new Error(`candidate ${candidateRoot}: unexpected baseline commit ${JSON.stringify(baselineCommit)}`);
  }
  return { candidateRoot, baselineCommit };
}

/* -------------------------------------------------------------------------- */
/* Batch execution lifecycle                                                  */
/* -------------------------------------------------------------------------- */

/** The live phase of one batch case, as recorded in `batch-state.json`. */
export type BatchCasePhase =
  | "unstarted"
  | "preparing-candidate"
  | "running-pi"
  | "discovering-run"
  | "running-assertion"
  | "ingesting"
  | "scoring"
  | "aggregating"
  | "completed"
  | "failed";

/** The fixed per-case observation artifacts, by relative name. */
export interface CaseObservationPaths {
  piStdout: string;
  piStderr: string;
  piProcessResult: string;
  assertionStdout: string;
  assertionStderr: string;
  assertionProcessResult: string;
  executionRecord: string;
  caseScore: string;
}

/** One ordered case entry in the live `batch-state.json` summary. */
export interface BatchCaseStateEntry {
  caseId: string;
  phase: BatchCasePhase;
  candidateRoot?: string;
  baselineCommit?: string;
  runId?: string;
  runDirectory?: string;
  /** Relative names of the per-case observation artifacts once completed. */
  observations?: CaseObservationPaths;
  /** Actionable, one-line failure detail for a failed case. */
  error?: string;
}

/**
 * The live batch summary (`batch-state.json`). This is the only artifact the
 * invocation rewrites; every other artifact is written exactly once and is
 * never reopened, deleted, or overwritten.
 */
export interface BatchState {
  schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  status: "in-progress" | "completed" | "failed";
  outputRoot: string;
  factoryVersionRef: string;
  caseOrder: string[];
  cases: BatchCaseStateEntry[];
  failure?: { caseId?: string; phase: BatchCasePhase; error: string };
  aggregate?: { inputPath: string; scorePath: string };
}

/** Write one text artifact with exactly the supplied bytes (nothing added). */
async function writeTextFile(filePath: string, content: string): Promise<void> {
  try {
    await writeFile(filePath, content, "utf8");
  } catch (error) {
    throw new Error(`cannot persist ${filePath} (${describeError(error)})`);
  }
}

/** Write one JSON artifact as pretty-printed JSON plus a trailing newline. */
async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Persist one captured process outcome under its three fixed artifact names:
 * `<label>.stdout.txt` and `<label>.stderr.txt` carry the exact captured
 * bytes; `<label>-process-result.json` carries the command/cwd metadata plus
 * the process result (exit code, signal, launch error).
 */
async function persistProcessOutcome(
  caseDirectory: string,
  label: "pi" | "assertion",
  request: ProcessRequest,
  result: ProcessResult,
): Promise<void> {
  await writeTextFile(join(caseDirectory, `${label}.stdout.txt`), result.stdout);
  await writeTextFile(join(caseDirectory, `${label}.stderr.txt`), result.stderr);
  await writeJsonFile(join(caseDirectory, `${label}-process-result.json`), {
    executable: request.executable,
    args: request.args,
    cwd: request.cwd,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    signal: result.signal,
    ...(result.launchError === undefined ? {} : { launchError: result.launchError }),
  });
}

/**
 * Enumerate the directories directly under the candidate's fixed factory run
 * root and require exactly one — the single run this invocation's Pi process
 * must have produced. Zero or multiple directories is an infrastructure
 * failure; console prose and process exit codes are never consulted.
 */
async function discoverSingleRun(candidateRoot: string): Promise<{ runDirectory: string; runId: string }> {
  const runsRoot = join(candidateRoot, ".pi", "software-factory", "runs");
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error(`Pi produced no factory run directory under ${runsRoot}; exactly one is required`);
    }
    throw new Error(`cannot enumerate factory run directories under ${runsRoot} (${describeError(error)})`);
  }
  const runNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (runNames.length === 0) {
    throw new Error(`no factory run directory found under ${runsRoot}; exactly one is required`);
  }
  if (runNames.length > 1) {
    throw new Error(
      `multiple factory run directories found under ${runsRoot}: ` +
        `${runNames.map((name) => JSON.stringify(name)).join(", ")}; exactly one is required`,
    );
  }
  return { runDirectory: join(runsRoot, runNames[0]), runId: runNames[0] };
}

/**
 * Parse the assertion stdout as exactly one JSON value. Structure
 * validation (an array of `{assertionId, passed}` entries) and declared-id
 * binding are delegated to `ingestRunArtifacts` and the existing record
 * validation; only a stdout that is not a single JSON value fails at this
 * boundary. A nonzero assertion exit with usable declared results remains
 * evidence, not an infrastructure failure.
 */
function parseAssertionResults(caseId: string, stdout: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `assertion stdout for case ${caseId} is not a single JSON value (${describeError(error)}); ` +
        "malformed assertion output stops the batch",
    );
  }
  return parsed;
}

/** The evidence collected for one completed case. */
interface CompletedCaseEvidence {
  record: BenchmarkExecutionRecord;
  score: BenchmarkCaseScore;
}

/**
 * Execute one manifest case sequentially: prepare the candidate, launch Pi
 * exactly once, require exactly one run directory, launch the assertion
 * exactly once, then delegate ingestion and scoring to the existing
 * modules. The active phase is persisted before each launch and completion
 * after the case is scored; the observed evidence (stdout, stderr, exit code,
 * signal, command/cwd metadata, launch errors) is persisted verbatim and
 * never written to the batch's final stdout.
 */
async function executeCase(params: {
  validatedCase: ValidatedBatchCase;
  caseIndex: number;
  outputPath: string;
  factoryVersionRef: string;
  candidateConfig: CandidateFactoryConfig;
  runner: ProcessRunner;
  state: BatchState;
}): Promise<CompletedCaseEvidence> {
  const { validatedCase, caseIndex, outputPath, factoryVersionRef, candidateConfig, runner, state } = params;
  const entry = state.cases[caseIndex];
  const caseDirectory = caseOutputDirectory(outputPath, validatedCase.caseId);
  const setPhase = async (phase: BatchCasePhase): Promise<void> => {
    entry.phase = phase;
    await persistBatchState(state);
  };

  await setPhase("preparing-candidate");
  const prepared = await prepareCandidate({
    validatedCase,
    caseOutputDirectory: caseDirectory,
    candidateConfig,
    runner,
  });
  entry.candidateRoot = prepared.candidateRoot;
  entry.baselineCommit = prepared.baselineCommit;

  await setPhase("running-pi");
  const piRequest = buildPiProcessRequest(prepared.candidateRoot, validatedCase.definition.objective);
  const piResult = await runner(piRequest);
  await persistProcessOutcome(caseDirectory, "pi", piRequest, piResult);

  await setPhase("discovering-run");
  const discovered = await discoverSingleRun(prepared.candidateRoot);
  entry.runId = discovered.runId;
  entry.runDirectory = discovered.runDirectory;

  await setPhase("running-assertion");
  const assertionRequest = buildAssertionProcessRequest(validatedCase.assertionPath, prepared.candidateRoot);
  const assertionResult = await runner(assertionRequest);
  await persistProcessOutcome(caseDirectory, "assertion", assertionRequest, assertionResult);

  const assertionResults = parseAssertionResults(validatedCase.caseId, assertionResult.stdout);

  await setPhase("ingesting");
  const record = await ingestRunArtifacts(discovered.runDirectory, {
    caseId: validatedCase.caseId,
    factoryVersionRef,
    humanImplementationIntervention: validatedCase.humanImplementationIntervention,
    assertionResults: assertionResults as ReadonlyArray<BenchmarkAssertionResult>,
  });
  await writeJsonFile(join(caseDirectory, "execution-record.json"), record);

  await setPhase("scoring");
  const score = scoreCase(validatedCase.definition, record);
  await writeJsonFile(join(caseDirectory, "case-score.json"), score);

  entry.observations = {
    piStdout: "pi.stdout.txt",
    piStderr: "pi.stderr.txt",
    piProcessResult: "pi-process-result.json",
    assertionStdout: "assertion.stdout.txt",
    assertionStderr: "assertion.stderr.txt",
    assertionProcessResult: "assertion-process-result.json",
    executionRecord: "execution-record.json",
    caseScore: "case-score.json",
  };
  await setPhase("completed");

  return { record, score };
}

/**
 * Persist the live `batch-state.json` summary. This is the only artifact the
 * invocation rewrites. Write failures propagate to the caller so normal
 * execution fails stop when the live audit record can no longer be written.
 * The two call sites that already hold a primary failure wrap this call in a
 * local guard so their failed-state reporting stays best-effort.
 */
async function persistBatchState(state: BatchState): Promise<void> {
  await writeJsonFile(join(state.outputRoot, "batch-state.json"), state);
}

/* -------------------------------------------------------------------------- */
/* Batch entry point                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Run one sequential, fail-stop autonomy batch and return the final
 * aggregate score.
 *
 * Strict prevalidation of the manifest and the projected models
 * configuration, and fresh-output validation and exclusive claiming, all
 * complete before any subprocess launches. The immutable top-level evidence
 * (`validated-manifest.json`, `provenance.json`) is then persisted, the live
 * `batch-state.json` summary is initialized, and each manifest case is
 * executed in order with at most one Pi and one assertion launch. Terminal
 * outcomes (HUMAN/FAILED/BLOCKED), failed assertion results, nonzero
 * assertion exits with usable declared results, and `passed: false` scores
 * are evidence, never retry triggers. Any infrastructure failure stops the
 * batch before the next case, leaves prior completed observation files
 * intact, and records the failed case, phase, and error in
 * `batch-state.json` where writable. After every case completes,
 * `aggregate-input.json` (the exact `bench:score-aggregate` envelope in
 * manifest order) and `aggregate-score.json` are persisted and the
 * deterministic aggregate is returned; the CLI boundary alone writes it to
 * stdout.
 */
export async function runBatch(
  options: BatchRunOptions,
  dependencies: RunBatchDependencies = {},
): Promise<BenchmarkAggregateScore> {
  const runner = dependencies.runner ?? createProductionProcessRunner();
  const manifestPath = resolve(options.input);
  const factoryConfigPath = resolve(options.factoryConfig);
  const manifestValue = await readJsonFile(manifestPath, "manifest");
  const validated = await validateBatchManifest(manifestValue, dirname(manifestPath));
  const configValue = await readJsonFile(factoryConfigPath, "factory config");
  const candidateConfig = validateFactoryConfigModels(configValue, factoryConfigPath);
  const outputPath = resolve(options.output);
  validateFreshOutputPath(outputPath);
  await claimOutputDirectory(outputPath);

  // Immutable top-level evidence: the validated manifest (preserved
  // unchanged) and the batch provenance.
  await writeJsonFile(join(outputPath, "validated-manifest.json"), manifestValue);
  await writeJsonFile(join(outputPath, "provenance.json"), {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    manifestPath,
    factoryConfigPath,
    factoryVersionRef: validated.factoryVersionRef,
    candidateConfig,
    caseOrder: validated.cases.map((c) => c.caseId),
    cases: validated.cases.map((c) => ({
      caseId: c.caseId,
      caseDirectory: c.caseDirectory,
      definitionPath: c.definitionPath,
      assertionPath: c.assertionPath,
      fixtureDirectory: c.fixtureDirectory,
      definition: c.definition,
      humanImplementationIntervention: c.humanImplementationIntervention,
    })),
  });

  const state: BatchState = {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    status: "in-progress",
    outputRoot: outputPath,
    factoryVersionRef: validated.factoryVersionRef,
    caseOrder: validated.cases.map((c) => c.caseId),
    cases: validated.cases.map((c) => ({ caseId: c.caseId, phase: "unstarted" as const })),
  };
  await persistBatchState(state);

  const executionRecords: BenchmarkExecutionRecord[] = [];
  for (let i = 0; i < validated.cases.length; i += 1) {
    const validatedCase = validated.cases[i];
    const entry = state.cases[i];
    try {
      const evidence = await executeCase({
        validatedCase,
        caseIndex: i,
        outputPath,
        factoryVersionRef: validated.factoryVersionRef,
        candidateConfig,
        runner,
        state,
      });
      executionRecords.push(evidence.record);
    } catch (error) {
      const failedPhase = entry.phase;
      entry.phase = "failed";
      entry.error = oneLine(describeError(error));
      state.status = "failed";
      state.failure = { caseId: validatedCase.caseId, phase: failedPhase, error: entry.error };
      try {
        // Best-effort failed-state report: a second write failure must not
        // mask the primary error rethrown below.
        await persistBatchState(state);
      } catch {
        // The reporting write failed; the primary error is authoritative.
      }
      throw error;
    }
  }

  const definitions = validated.cases.map((c) => c.definition);
  const aggregateInputPath = join(outputPath, "aggregate-input.json");
  const aggregateScorePath = join(outputPath, "aggregate-score.json");
  try {
    await writeJsonFile(aggregateInputPath, { definitions, executionRecords });
    const aggregate = scoreAggregate(definitions, executionRecords);
    await writeJsonFile(aggregateScorePath, aggregate);
    state.status = "completed";
    state.aggregate = { inputPath: aggregateInputPath, scorePath: aggregateScorePath };
    await persistBatchState(state);
    return aggregate;
  } catch (error) {
    state.status = "failed";
    state.failure = { phase: "aggregating", error: oneLine(describeError(error)) };
    try {
      // Best-effort failed-state report: a second write failure must not
      // mask the primary error rethrown below.
      await persistBatchState(state);
    } catch {
      // The reporting write failed; the primary error is authoritative.
    }
    throw error;
  }
}

/** Write the single diagnostic line for one failed invocation. */
function reportError(error: unknown): void {
  process.stderr.write(`bench:run-batch: ${oneLine(describeError(error))}\n`);
  process.exitCode = 1;
}

/**
 * CLI entry point: parse the strict flags and run the batch. On success,
 * stdout receives exactly the serialized aggregate score plus a newline
 * (even when the release gate fails); on failure, one prefixed diagnostic
 * line goes to stderr with a non-zero exit code and no stdout payload.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let options: BatchRunOptions;
  try {
    options = parseBatchCliArgs(argv);
  } catch (error) {
    reportError(error);
    return;
  }
  try {
    const aggregate = await runBatch(options);
    process.stdout.write(`${JSON.stringify(aggregate)}\n`);
  } catch (error) {
    reportError(error);
  }
}

// Direct-execution guard: importing this module starts no batch; only
// executing this file directly (as the resolved entry point) runs one.
const entryPoint = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entryPoint === resolve(fileURLToPath(import.meta.url))) {
  void main();
}
