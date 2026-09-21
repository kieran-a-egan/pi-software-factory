import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
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
  const id = `SF-${safeStamp()}`;
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });

  const write = (name: string, value: unknown) => {
    writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
