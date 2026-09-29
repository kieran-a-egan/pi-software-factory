import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { persistModelRoles } from "../src/setup.js";
import type { AvailableModel, ModelPersistenceIo } from "../src/setup.js";
import type { ModelRoles } from "../src/types.js";

const ROLES = ["scout", "architect", "implementer", "reviewer", "repairer"] as const;
const THINKINGS = ["low", "high", "off", "max", "xhigh"] as const;

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-setup-"));
  dirs.push(dir);
  return dir;
}

function piDir(dir: string): string {
  return join(dir, ".pi");
}

function configPath(dir: string): string {
  return join(dir, ".pi", "software-factory.json");
}

function writeRaw(dir: string, value: unknown): string {
  mkdirSync(piDir(dir), { recursive: true });
  const path = configPath(dir);
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
}

function writeRawText(dir: string, text: string): string {
  mkdirSync(piDir(dir), { recursive: true });
  const path = configPath(dir);
  writeFileSync(path, text, "utf8");
  return path;
}

function piEntries(dir: string): string[] {
  return existsSync(piDir(dir)) ? readdirSync(piDir(dir)).sort() : [];
}

function tempEntries(dir: string): string[] {
  return piEntries(dir).filter((name) => name.startsWith("software-factory.json.tmp-"));
}

function snapshot(): AvailableModel[] {
  return [
    { provider: "prov-scout", model: "model-scout", name: "Scout Model" },
    { provider: "prov-architect", model: "model-architect" },
    { provider: "prov-implementer", model: "model-implementer" },
    { provider: "prov-reviewer", model: "model-reviewer" },
    { provider: "prov-repairer", model: "model-repairer" },
  ];
}

function expectedRoles(snap: AvailableModel[]): ModelRoles {
  const roles = {} as ModelRoles;
  ROLES.forEach((role, i) => {
    roles[role] = { provider: snap[i].provider, model: snap[i].model, thinking: THINKINGS[i] };
  });
  return roles;
}

function selection(snap: AvailableModel[]): Record<string, unknown> {
  return structuredClone(expectedRoles(snap)) as unknown as Record<string, unknown>;
}

function roleField(selection: Record<string, unknown>, role: string): Record<string, unknown> {
  return selection[role] as Record<string, unknown>;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe("persistModelRoles successful persistence", () => {
  it("replaces the entire models block and preserves every non-model property verbatim", () => {
    const dir = freshDir();
    const existing = {
      models: {
        scout: { provider: "old-provider", model: "old-model", thinking: "low" },
        planner: { provider: "old-provider-2", model: "old-model-2", thinking: "low" },
      },
      jev: { model: "jev-latest", minChoiceConfidence: 0.6, minNoulProbability: 0.65 },
      verificationCommands: ["npm test", "npm run typecheck"],
      parallelImplementation: { enabled: false, maxParallelUnits: 4 },
      maxRepairPasses: 3,
      runRoot: ".okf/work",
      contextPaths: ["AGENTS.md", ".okf/project"],
      contextMaxBytes: 123_456,
      requireCleanWorkingTree: false,
      extensions: {
        "custom.extension": { enabled: true, nested: { deep: [1, 2, 3], flag: "keep" } },
      },
    };
    writeRaw(dir, existing);
    const snap = snapshot();

    const result = persistModelRoles(dir, selection(snap), snap);

    const after = JSON.parse(readFileSync(configPath(dir), "utf8")) as Record<string, unknown>;
    for (const [key, value] of Object.entries(existing)) {
      if (key !== "models") expect(after[key]).toEqual(value);
    }
    expect(after.models).toEqual(expectedRoles(snap));
    expect(Object.keys(after.models as object).sort()).toEqual([...ROLES].sort());
    expect(result).toEqual(expectedRoles(snap));
    expect(tempEntries(dir)).toEqual([]);
  });

  it("serializes exactly JSON.stringify(candidate, null, 2) plus one final newline", () => {
    const dir = freshDir();
    const existing = { jev: { model: "jev-latest" }, runRoot: ".okf/work" };
    writeRaw(dir, existing);
    const snap = snapshot();

    persistModelRoles(dir, selection(snap), snap);

    const candidate = { ...existing, models: expectedRoles(snap) };
    expect(readFileSync(configPath(dir), "utf8")).toBe(JSON.stringify(candidate, null, 2) + "\n");
  });

  it("loads through loadConfig with exactly the selected models and no inherited old role fields", () => {
    const dir = freshDir();
    writeRaw(dir, {
      models: {
        scout: { provider: "p-old", model: "m-old", thinking: "low", alias: "legacy" },
        architect: { provider: "p-old", model: "m-old", thinking: "low" },
        implementer: { provider: "p-old", model: "m-old", thinking: "low" },
        reviewer: { provider: "p-old", model: "m-old", thinking: "low" },
        repairer: { provider: "p-old", model: "m-old", thinking: "low" },
        legacyRole: { provider: "p-old", model: "m-old", thinking: "low" },
      },
    });
    const snap = snapshot();

    persistModelRoles(dir, selection(snap), snap);

    expect(loadConfig(dir).models).toEqual(expectedRoles(snap));
  });

  it("creates a models-only object when the file is absent with an existing empty .pi directory", () => {
    const dir = freshDir();
    mkdirSync(piDir(dir), { recursive: true });
    const snap = snapshot();

    persistModelRoles(dir, selection(snap), snap);

    const after = JSON.parse(readFileSync(configPath(dir), "utf8")) as Record<string, unknown>;
    expect(after).toEqual({ models: expectedRoles(snap) });
    expect(Object.keys(after)).toEqual(["models"]);
  });

  it("creates the .pi directory when it is missing", () => {
    const dir = freshDir();
    expect(existsSync(piDir(dir))).toBe(false);
    const snap = snapshot();

    persistModelRoles(dir, selection(snap), snap);

    expect(existsSync(configPath(dir))).toBe(true);
    const after = JSON.parse(readFileSync(configPath(dir), "utf8")) as Record<string, unknown>;
    expect(after).toEqual({ models: expectedRoles(snap) });
  });

  it("returns the validated selected roles, not a resolved config", () => {
    const dir = freshDir();
    const snap = snapshot();

    const result = persistModelRoles(dir, selection(snap), snap);

    expect(result).toEqual(expectedRoles(snap));
    expect(Object.keys(result).sort()).toEqual([...ROLES].sort());
    for (const key of ["jev", "runRoot", "contextBudget", "planningLoops"]) {
      expect(Object.keys(result)).not.toContain(key);
    }
  });

  it("repeated saves leave no temporary files", () => {
    const dir = freshDir();
    writeRaw(dir, { jev: { model: "jev-latest" } });
    const snap = snapshot();

    for (let i = 0; i < 3; i += 1) {
      persistModelRoles(dir, selection(snap), snap);
      const after = JSON.parse(readFileSync(configPath(dir), "utf8")) as Record<string, unknown>;
      expect(after.models).toEqual(expectedRoles(snap));
    }

    expect(piEntries(dir)).toEqual(["software-factory.json"]);
  });
});

describe("persistModelRoles fail-closed persistence", () => {
  function expectUnchanged(
    dir: string,
    before: string,
    fn: () => void,
    pattern?: RegExp,
  ): void {
    if (pattern === undefined) {
      expect(fn).toThrow();
    } else {
      expect(fn).toThrow(pattern);
    }
    expect(readFileSync(configPath(dir), "utf8")).toBe(before);
    expect(tempEntries(dir)).toEqual([]);
  }

  it("leaves original bytes unchanged and creates no temp artifact on malformed JSON", () => {
    const dir = freshDir();
    writeRawText(dir, "{ definitely not json");
    const before = readFileSync(configPath(dir), "utf8");
    const snap = snapshot();

    expectUnchanged(dir, before, () => persistModelRoles(dir, selection(snap), snap));
  });

  for (const root of [null, [], "a string", 42, true]) {
    it(`rejects a ${JSON.stringify(root)} root without touching the destination`, () => {
      const dir = freshDir();
      writeRawText(dir, JSON.stringify(root));
      const before = readFileSync(configPath(dir), "utf8");
      const snap = snapshot();

      expectUnchanged(
        dir,
        before,
        () => persistModelRoles(dir, selection(snap), snap),
        /expected a JSON object/,
      );
    });
  }

  it("rejects an invalid selection without touching the destination", () => {
    const dir = freshDir();
    writeRaw(dir, { jev: { model: "jev-latest" } });
    const before = readFileSync(configPath(dir), "utf8");
    const snap = snapshot();

    const missing = selection(snap);
    delete missing.repairer;
    expectUnchanged(
      dir,
      before,
      () => persistModelRoles(dir, missing, snap),
      /missing role "repairer"/,
    );

    const unknown = selection(snap);
    unknown.planner = { provider: "p", model: "m", thinking: "low" };
    expectUnchanged(
      dir,
      before,
      () => persistModelRoles(dir, unknown, snap),
      /unknown role "planner"/,
    );

    const badThinking = selection(snap);
    roleField(badThinking, "scout").thinking = "ultra";
    expectUnchanged(
      dir,
      before,
      () => persistModelRoles(dir, badThinking, snap),
      /scout\.thinking: expected one of/,
    );

    const outside = selection(snap);
    roleField(outside, "scout").model = "ghost-model";
    expectUnchanged(
      dir,
      before,
      () => persistModelRoles(dir, outside, snap),
      /not in the available model snapshot/,
    );

    // Inherited (non-own) ModelRef fields are rejected before any write.
    const inherited = selection(snap);
    inherited.scout = Object.create(roleField(selection(snap), "scout"));
    expectUnchanged(
      dir,
      before,
      () => persistModelRoles(dir, inherited, snap),
      /scout\.provider: missing field/,
    );
  });

  it("rejects invalid preserved candidate values without changing bytes or migrating fields", () => {
    const snap = snapshot();
    const cases: Array<{ raw: Record<string, unknown>; pattern: RegExp }> = [
      { raw: { contextBudget: { warningTokens: 80_000 } }, pattern: /Invalid contextBudget/ },
      {
        raw: { planningLoops: { maxReplanPasses: -1 } },
        pattern: /Invalid planningLoops\.maxReplanPasses/,
      },
      {
        raw: { parallelImplementation: { maxParallelUnits: 0 } },
        pattern: /Invalid parallelImplementation\.maxParallelUnits/,
      },
      { raw: { qwen: { provider: "p", model: "m" } }, pattern: /obsolete/ },
      { raw: { astra: { provider: "p", model: "m" } }, pattern: /obsolete/ },
      {
        raw: { maxDeterministicRepairPasses: -1 },
        pattern: /Invalid maxDeterministicRepairPasses/,
      },
      {
        raw: { maxReviewRepairPasses: 0.5 },
        pattern: /Invalid maxReviewRepairPasses/,
      },
      {
        raw: { maxRepairPasses: -1 },
        pattern: /Invalid maxRepairPasses/,
      },
      {
        raw: { maxRepairPasses: 2.5 },
        pattern: /Invalid maxRepairPasses/,
      },
      {
        raw: { maxRepairPasses: 2, maxDeterministicRepairPasses: 1 },
        pattern: /legacy maxRepairPasses cannot be combined/,
      },
    ];
    for (const { raw, pattern } of cases) {
      const dir = freshDir();
      writeRaw(dir, raw);
      const before = readFileSync(configPath(dir), "utf8");
      expectUnchanged(dir, before, () => persistModelRoles(dir, selection(snap), snap), pattern);
    }
  });

  it("propagates a non-ENOENT read error without replacement", () => {
    const dir = freshDir();
    // The destination path exists as a directory: readFileSync fails with a
    // non-ENOENT error, which must propagate untouched.
    mkdirSync(configPath(dir), { recursive: true });
    const snap = snapshot();

    expect(() => persistModelRoles(dir, selection(snap), snap)).toThrow();
    expect(statSync(configPath(dir)).isDirectory()).toBe(true);
    expect(tempEntries(dir)).toEqual([]);
  });
});

describe("persistModelRoles atomic write behavior", () => {
  it("writes a uniquely named temporary sibling then renames it, with no pre-deletion", () => {
    const dir = freshDir();
    writeRaw(dir, { jev: { model: "jev-latest" } });
    const snap = snapshot();
    const calls: Array<{ op: "writeTemp" | "rename" | "removeTemp"; path: string; data?: string }> =
      [];
    const io: ModelPersistenceIo = {
      writeTemp: (temp, data) => {
        calls.push({ op: "writeTemp", path: temp, data });
        writeFileSync(temp, data, "utf8");
      },
      rename: (temp, dest) => {
        calls.push({ op: "rename", path: temp });
        renameSync(temp, dest);
      },
      removeTemp: (temp) => {
        calls.push({ op: "removeTemp", path: temp });
        rmSync(temp, { force: true });
      },
    };

    persistModelRoles(dir, selection(snap), snap, io);
    persistModelRoles(dir, selection(snap), snap, io);

    expect(calls.map((call) => call.op)).toEqual(["writeTemp", "rename", "writeTemp", "rename"]);
    const firstTemp = calls[0].path;
    const secondTemp = calls[2].path;
    expect(firstTemp).not.toBe(secondTemp);
    expect(dirname(firstTemp)).toBe(piDir(dir));
    expect(firstTemp).not.toBe(configPath(dir));
    expect(basename(firstTemp).startsWith("software-factory.json.tmp-")).toBe(true);
    const candidate = { jev: { model: "jev-latest" }, models: expectedRoles(snap) };
    expect(calls[0].data).toBe(JSON.stringify(candidate, null, 2) + "\n");
    expect(piEntries(dir)).toEqual(["software-factory.json"]);
  });

  it("preserves destination bytes and cleans the temp when the write fails after partial bytes", () => {
    const snap = snapshot();
    const cleaned: string[] = [];
    const io: ModelPersistenceIo = {
      writeTemp: (temp) => {
        writeFileSync(temp, "partial-bytes", "utf8");
        throw new Error("injected write failure");
      },
      rename: () => {
        throw new Error("rename must not run");
      },
      removeTemp: (temp) => {
        cleaned.push(temp);
        rmSync(temp, { force: true });
      },
    };

    const dir = freshDir();
    writeRaw(dir, { jev: { model: "jev-latest" } });
    const before = readFileSync(configPath(dir), "utf8");
    expect(() => persistModelRoles(dir, selection(snap), snap, io)).toThrow(
      /injected write failure/,
    );
    expect(readFileSync(configPath(dir), "utf8")).toBe(before);
    expect(tempEntries(dir)).toEqual([]);
    expect(cleaned).toHaveLength(1);

    const absent = freshDir();
    cleaned.length = 0;
    expect(() => persistModelRoles(absent, selection(snap), snap, io)).toThrow(
      /injected write failure/,
    );
    expect(existsSync(configPath(absent))).toBe(false);
    expect(tempEntries(absent)).toEqual([]);
    expect(cleaned).toHaveLength(1);
  });

  it("preserves destination bytes and cleans the temp when the rename fails after a successful temp write", () => {
    const snap = snapshot();
    const io: ModelPersistenceIo = {
      writeTemp: (temp, data) => writeFileSync(temp, data, "utf8"),
      rename: () => {
        throw new Error("injected rename failure");
      },
      removeTemp: (temp) => rmSync(temp, { force: true }),
    };

    const dir = freshDir();
    writeRaw(dir, { jev: { model: "jev-latest" } });
    const before = readFileSync(configPath(dir), "utf8");
    expect(() => persistModelRoles(dir, selection(snap), snap, io)).toThrow(
      /injected rename failure/,
    );
    expect(readFileSync(configPath(dir), "utf8")).toBe(before);
    expect(tempEntries(dir)).toEqual([]);

    const absent = freshDir();
    expect(() => persistModelRoles(absent, selection(snap), snap, io)).toThrow(
      /injected rename failure/,
    );
    expect(existsSync(configPath(absent))).toBe(false);
    expect(tempEntries(absent)).toEqual([]);
  });

  it("keeps the primary rename error when cleanup fails and never deletes the destination", () => {
    const dir = freshDir();
    writeRaw(dir, { jev: { model: "jev-latest" } });
    const before = readFileSync(configPath(dir), "utf8");
    const snap = snapshot();
    let cleanupAttempts = 0;
    const io: ModelPersistenceIo = {
      writeTemp: (temp, data) => writeFileSync(temp, data, "utf8"),
      rename: () => {
        throw new Error("primary rename failure");
      },
      removeTemp: () => {
        cleanupAttempts += 1;
        throw new Error("cleanup failure");
      },
    };

    expect(() => persistModelRoles(dir, selection(snap), snap, io)).toThrow(
      /primary rename failure/,
    );
    expect(cleanupAttempts).toBe(1);
    expect(readFileSync(configPath(dir), "utf8")).toBe(before);
    // The temp file remains because cleanup failed; it is removed with the
    // temporary test directory in afterEach.
    expect(tempEntries(dir)).toHaveLength(1);
  });
});
