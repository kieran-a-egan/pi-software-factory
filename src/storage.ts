import { appendFileSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FactoryRunState } from "./types.js";

export interface RunStore {
  dir: string;
  write(name: string, value: unknown): void;
  appendDecision(value: unknown): void;
  writeState(state: FactoryRunState): void;
}

/**
 * Narrow synchronous filesystem seam for the run-store rename. The default
 * implementation uses the Node filesystem; tests inject deterministic
 * adapters to record rename attempts and waits. The seam is limited to the
 * two operations the write path needs: no locking, no cleanup, no general
 * storage framework.
 */
export interface RunStoreIo {
  /** Atomically rename `source` over `destination`. */
  rename(source: string, destination: string): void;
  /** Synchronous pause of exactly `milliseconds`. */
  wait(milliseconds: number): void;
}

const defaultRunStoreIo: RunStoreIo = {
  rename(source, destination) {
    renameSync(source, destination);
  },
  wait(milliseconds) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  },
};

const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_WAIT_MS = 25;

function isTransientRenameError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && TRANSIENT_RENAME_CODES.has(code);
}

/**
 * Bounded rename with a fixed retry budget. A successful rename returns
 * immediately. Only EPERM, EACCES, and EBUSY permit another attempt, with
 * one fixed 25 ms wait between attempts (at most four waits). Any other
 * error rethrows immediately, and an exhausted budget rethrows the first
 * transient rename error by object identity.
 */
function renameWithTransientRetry(
  io: RunStoreIo,
  source: string,
  destination: string,
): void {
  let firstTransientError: unknown;
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++) {
    try {
      io.rename(source, destination);
      return;
    } catch (error) {
      if (!isTransientRenameError(error)) throw error;
      if (firstTransientError === undefined) firstTransientError = error;
      if (attempt === RENAME_ATTEMPTS - 1) throw firstTransientError;
      io.wait(RENAME_RETRY_WAIT_MS);
    }
  }
}

function safeStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function createRunStore(
  root: string,
  io: RunStoreIo = defaultRunStoreIo,
): RunStore {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, `SF-${safeStamp()}-`));

  const write = (name: string, value: unknown) => {
    const path = join(dir, name);
    writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameWithTransientRetry(io, `${path}.tmp`, path);
  };

  return {
    dir,
    write,
    appendDecision(value: unknown) {
      appendFileSync(join(dir, "decisions.jsonl"), `${JSON.stringify(value)}\n`, "utf8");
    },
    writeState(state: FactoryRunState) {
      write("state.json", state);
    },
  };
}
