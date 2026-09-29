import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL_ROLES, resolveConfig, THINKING_LEVELS } from "./config.js";
import type { ModelRef, ModelRoles, ThinkingLevel } from "./types.js";

/**
 * Normalized representation of a single selectable model observed in the
 * live Pi registry. `provider` and `model` are the exact identity strings
 * used to resolve the model at runtime; `name` is optional display metadata
 * that never participates in identity matching.
 */
export interface AvailableModel {
  provider: string;
  model: string;
  name?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonblankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Normalizes live Pi registry-shaped entries into fresh AvailableModel
 * objects. Each entry must be a plain object carrying its own exact
 * `provider` and `id` identity strings plus, optionally, a string `name`
 * display label. Identity strings are preserved verbatim: they are never
 * trimmed, aliased, or rewritten. Duplicate ids under different providers
 * remain distinct entries. Extra registry fields (reasoning, contextWindow,
 * cost, ...) are ignored.
 */
export function normalizeAvailableModels(entries: unknown): AvailableModel[] {
  if (!Array.isArray(entries)) {
    throw new Error(
      "Invalid available models: expected an array of registry entries with provider and id.",
    );
  }
  return entries.map((entry, index) => {
    if (!isPlainRecord(entry)) {
      throw new Error(
        `Invalid available model entry ${index}: expected an object with provider and id fields.`,
      );
    }
    if (!isNonblankString(entry.provider)) {
      throw new Error(
        `Invalid available model entry ${index}.provider: expected a nonblank string.`,
      );
    }
    if (!isNonblankString(entry.id)) {
      throw new Error(
        `Invalid available model entry ${index}.id: expected a nonblank string.`,
      );
    }
    const model: AvailableModel = { provider: entry.provider, model: entry.id };
    if (entry.name !== undefined) {
      if (typeof entry.name !== "string") {
        throw new Error(`Invalid available model entry ${index}.name: expected a string.`);
      }
      model.name = entry.name;
    }
    return model;
  });
}

const REF_FIELDS = ["provider", "model", "thinking"] as const;

function isSnapshotEntry(entry: unknown): entry is AvailableModel {
  if (!isPlainRecord(entry)) return false;
  if (!isNonblankString(entry.provider)) return false;
  if (!isNonblankString(entry.model)) return false;
  if (entry.name !== undefined && typeof entry.name !== "string") return false;
  return true;
}

/**
 * Indexes a snapshot by exact (provider, model) pair using a nested
 * provider -> Set<model> structure, so membership matching is collision-safe
 * and never relies on delimiter concatenation.
 */
function buildPairIndex(availableModels: readonly AvailableModel[]): Map<string, Set<string>> {
  if (!Array.isArray(availableModels)) {
    throw new Error(
      "Invalid available models: expected an array of normalized AvailableModel entries.",
    );
  }
  const index = new Map<string, Set<string>>();
  availableModels.forEach((entry, i) => {
    if (!isSnapshotEntry(entry)) {
      throw new Error(
        `Invalid available model entry ${i}: expected a plain object with nonblank provider and model identity strings.`,
      );
    }
    let models = index.get(entry.provider);
    if (models === undefined) {
      models = new Set<string>();
      index.set(entry.provider, models);
    }
    models.add(entry.model);
  });
  return index;
}

/**
 * Validates a completed five-role selection against a caller-supplied
 * normalized snapshot. Pure: it inspects but never mutates the selection or
 * the snapshot, and returns fresh ModelRef objects containing exactly the
 * selected provider/model/thinking values. Fails closed on unknown roles or
 * fields, missing own fields (prototype-inherited values are never accepted),
 * malformed containers, blank or non-string identities, invalid thinking
 * levels, and (provider, model) pairs that do not exist in the supplied
 * snapshot. Display names are never consulted for membership.
 */
export function validateModelRoles(
  selection: unknown,
  availableModels: readonly AvailableModel[],
): ModelRoles {
  if (!isPlainRecord(selection)) {
    throw new Error(
      `Invalid model selection: expected an object with ${MODEL_ROLES.join(", ")} roles.`,
    );
  }
  for (const key of Object.getOwnPropertyNames(selection)) {
    if (!(MODEL_ROLES as readonly string[]).includes(key)) {
      throw new Error(`Invalid model selection: unknown role "${key}".`);
    }
  }
  for (const role of MODEL_ROLES) {
    if (!Object.hasOwn(selection, role)) {
      throw new Error(`Invalid model selection: missing role "${role}".`);
    }
  }

  const pairs = buildPairIndex(availableModels);
  const roles = {} as ModelRoles;

  for (const role of MODEL_ROLES) {
    const ref = selection[role];
    if (!isPlainRecord(ref)) {
      throw new Error(
        `Invalid model selection ${role}: expected an object with provider, model, and thinking fields.`,
      );
    }
    for (const key of Object.getOwnPropertyNames(ref)) {
      if (!(REF_FIELDS as readonly string[]).includes(key)) {
        throw new Error(`Invalid model selection ${role}.${key}: unknown field.`);
      }
    }
    for (const key of REF_FIELDS) {
      if (!Object.hasOwn(ref, key)) {
        throw new Error(`Invalid model selection ${role}.${key}: missing field.`);
      }
    }
    if (!isNonblankString(ref.provider)) {
      throw new Error(`Invalid model selection ${role}.provider: expected a nonblank string.`);
    }
    if (!isNonblankString(ref.model)) {
      throw new Error(`Invalid model selection ${role}.model: expected a nonblank string.`);
    }
    if (typeof ref.thinking !== "string" || !THINKING_LEVELS.includes(ref.thinking as ThinkingLevel)) {
      throw new Error(
        `Invalid model selection ${role}.thinking: expected one of ${THINKING_LEVELS.join(", ")}.`,
      );
    }
    const models = pairs.get(ref.provider);
    if (models === undefined || !models.has(ref.model)) {
      throw new Error(
        `Invalid model selection ${role}: the provider/model pair "${ref.provider}" / "${ref.model}" is not in the available model snapshot.`,
      );
    }
    roles[role] = {
      provider: ref.provider,
      model: ref.model,
      thinking: ref.thinking as ThinkingLevel,
    } satisfies ModelRef;
  }

  return roles;
}

/**
 * Narrow synchronous file operations for persistModelRoles. The default
 * implementation uses the Node filesystem; tests inject deterministic
 * adapters to exercise write/rename/cleanup failures. The seam is limited
 * to the three operations persistence needs: no locking, no UI, no general
 * storage framework.
 */
export interface ModelPersistenceIo {
  /** Create a new temporary sibling file containing exactly `data`. */
  writeTemp(tempPath: string, data: string): void;
  /** Atomically rename `tempPath` over `destPath`. */
  rename(tempPath: string, destPath: string): void;
  /** Best-effort removal of a temporary file; the caller swallows failures. */
  removeTemp(tempPath: string): void;
}

const defaultPersistenceIo: ModelPersistenceIo = {
  writeTemp(tempPath, data) {
    // "wx" creates the file exclusively: a pre-existing sibling is never
    // truncated or overwritten.
    writeFileSync(tempPath, data, { encoding: "utf8", flag: "wx" });
  },
  rename(tempPath, destPath) {
    renameSync(tempPath, destPath);
  },
  removeTemp(tempPath) {
    rmSync(tempPath, { force: true });
  },
};

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Persists a validated complete five-role selection by atomically replacing
 * only the raw top-level `models` property of .pi/software-factory.json.
 *
 * The selection is validated against the caller-supplied snapshot before
 * any filesystem access. The existing raw JSON object is read and parsed;
 * only ENOENT means the file is absent (in which case an empty object is
 * used). Every other read error propagates without replacement. A fresh
 * candidate replaces the entire `models` property with the validated
 * selection; no per-role merging and no serialized defaults occur. The
 * candidate is validated through the shared resolveConfig boundary and
 * serialized as 2-space JSON plus exactly one final newline before any
 * filesystem artifact is created. The output is written to a uniquely named
 * temporary sibling (created exclusively) and renamed over the destination;
 * the destination is never truncated or deleted first. On a write or rename
 * failure the temporary file is cleaned up best-effort and the original
 * error is rethrown; a cleanup failure never masks it and never touches the
 * destination.
 *
 * Returns the validated selected ModelRoles, not a resolved config.
 */
export function persistModelRoles(
  cwd: string,
  selection: unknown,
  availableModels: readonly AvailableModel[],
  io: ModelPersistenceIo = defaultPersistenceIo,
): ModelRoles {
  const roles = validateModelRoles(selection, availableModels);

  const configPath = join(cwd, ".pi", "software-factory.json");
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (!isPlainRecord(parsed)) {
      throw new Error(
        "Invalid .pi/software-factory.json: expected a JSON object at the top level.",
      );
    }
    raw = parsed;
  } catch (error) {
    if (!isEnoent(error)) throw error;
    raw = {};
  }

  const candidate: Record<string, unknown> = { ...raw, models: roles };
  resolveConfig(cwd, candidate);

  const serialized = `${JSON.stringify(candidate, null, 2)}\n`;

  mkdirSync(join(cwd, ".pi"), { recursive: true });

  const tempPath = join(cwd, ".pi", `software-factory.json.tmp-${randomUUID()}`);
  try {
    io.writeTemp(tempPath, serialized);
    io.rename(tempPath, configPath);
  } catch (error) {
    try {
      io.removeTemp(tempPath);
    } catch {
      // Preserve the primary write/rename error.
    }
    throw error;
  }

  return roles;
}
