import { appendFileSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FactoryRunState } from "./types.js";

export interface RunStore {
  dir: string;
  write(name: string, value: unknown): void;
  appendDecision(value: unknown): void;
  writeState(state: FactoryRunState): void;
}

function safeStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function createRunStore(root: string): RunStore {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, `SF-${safeStamp()}-`));

  const write = (name: string, value: unknown) => {
    const path = join(dir, name);
    writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(`${path}.tmp`, path);
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
