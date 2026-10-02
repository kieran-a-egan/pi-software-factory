import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunStore } from "../src/storage.js";
import type { RunStoreIo } from "../src/storage.js";
import type { FactoryRunState } from "../src/types.js";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-storage-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

interface IoCall {
  op: "rename" | "wait";
  source?: string;
  destination?: string;
  milliseconds?: number;
}

type RenameStep = { ok: true } | { error: unknown };

/**
 * Deterministic RunStoreIo adapter. Each rename consumes the next scripted
 * step: `{ ok: true }` delegates to the real renameSync, `{ error }` throws
 * it. Any rename beyond the script throws, so an extra attempt fails the
 * test. Waits are recorded, never slept. An optional `onRenameFailure` hook
 * observes each failed rename (with the recorded call) before the error is
 * thrown, letting tests capture destination bytes mid-retry.
 */
function scriptedIo(
  script: RenameStep[],
  onRenameFailure?: (call: IoCall) => void,
): { io: RunStoreIo; calls: IoCall[] } {
  const calls: IoCall[] = [];
  const io: RunStoreIo = {
    rename(source, destination) {
      const call: IoCall = { op: "rename", source, destination };
      calls.push(call);
      const step = script.shift();
      if (step === undefined) {
        throw new Error(`unexpected extra rename attempt ${calls.length}`);
      }
      if ("error" in step) {
        onRenameFailure?.(call);
        throw step.error;
      }
      renameSync(source, destination);
    },
    wait(milliseconds) {
      calls.push({ op: "wait", milliseconds });
    },
  };
  return { io, calls };
}

function withCode(code: string, message: string): Error {
  const error = new Error(message);
  (error as { code?: string }).code = code;
  return error;
}

function renamedCalls(calls: IoCall[]): IoCall[] {
  return calls.filter((call) => call.op === "rename");
}

function waitedCalls(calls: IoCall[]): IoCall[] {
  return calls.filter((call) => call.op === "wait");
}

function expectThrows(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

function state(): FactoryRunState {
  return {
    id: "run-test",
    createdAt: "2026-01-01T00:00:00.000Z",
    cwd: "/work",
    objective: "test objective",
    phase: "planning",
    deterministicRepairPasses: 0,
    reviewRepairPasses: 0,
    repairPasses: 0,
    rescoutPasses: 0,
    replanPasses: 0,
    planGatePasses: 0,
  };
}

describe("createRunStore rename retry behavior", () => {
  it("renames once without waiting and writes the serialization contract", () => {
    const { io, calls } = scriptedIo([{ ok: true }]);
    const store = createRunStore(freshDir(), io);
    const value = { phase: "ready", count: 2 };
    store.write("notes.json", value);

    const dest = join(store.dir, "notes.json");
    expect(calls).toEqual([{ op: "rename", source: `${dest}.tmp`, destination: dest }]);
    expect(readFileSync(dest, "utf8")).toBe(`${JSON.stringify(value, null, 2)}\n`);
    expect(readdirSync(store.dir)).toEqual(["notes.json"]);
  });

  it("replaces a prepopulated destination through the real renameSync", () => {
    const { io, calls } = scriptedIo([{ ok: true }]);
    const store = createRunStore(freshDir(), io);
    const dest = join(store.dir, "notes.json");
    writeFileSync(dest, "original bytes\n", "utf8");
    const value = { phase: "ready" };
    store.write("notes.json", value);

    expect(renamedCalls(calls)).toHaveLength(1);
    expect(readFileSync(dest, "utf8")).toBe(`${JSON.stringify(value, null, 2)}\n`);
    expect(readdirSync(store.dir)).toEqual(["notes.json"]);
  });

  for (const code of ["EPERM", "EACCES", "EBUSY"] as const) {
    it(`retries once after a transient ${code} and stops immediately on success`, () => {
      const observed: string[] = [];
      const { io, calls } = scriptedIo(
        [
          { error: withCode(code, "transient failure") },
          { ok: true },
        ],
        (call) => observed.push(readFileSync(call.destination!, "utf8")),
      );
      const store = createRunStore(freshDir(), io);
      const dest = join(store.dir, "notes.json");
      writeFileSync(dest, "original bytes\n", "utf8");
      const value = { ok: true };
      store.write("notes.json", value);

      expect(calls).toEqual([
        { op: "rename", source: `${dest}.tmp`, destination: dest },
        { op: "wait", milliseconds: 25 },
        { op: "rename", source: `${dest}.tmp`, destination: dest },
      ]);
      expect(observed).toEqual(["original bytes\n"]);
      expect(readFileSync(dest, "utf8")).toBe(`${JSON.stringify(value, null, 2)}\n`);
      expect(readdirSync(store.dir)).toEqual(["notes.json"]);
    });
  }

  it("succeeds on the final permitted attempt with no extra attempt or trailing wait", () => {
    const script: RenameStep[] = [0, 1, 2, 3].map((i) => ({
      error: withCode("EPERM", `transient failure ${i}`),
    }));
    script.push({ ok: true });
    const observed: string[] = [];
    const { io, calls } = scriptedIo(
      script,
      (call) => observed.push(readFileSync(call.destination!, "utf8")),
    );
    const store = createRunStore(freshDir(), io);
    const dest = join(store.dir, "notes.json");
    writeFileSync(dest, "original bytes\n", "utf8");
    const value = { ok: true };
    store.write("notes.json", value);

    const renames = renamedCalls(calls);
    expect(renames).toHaveLength(5);
    for (const call of renames) {
      expect(call.source).toBe(`${dest}.tmp`);
      expect(call.destination).toBe(dest);
    }
    expect(waitedCalls(calls)).toEqual([
      { op: "wait", milliseconds: 25 },
      { op: "wait", milliseconds: 25 },
      { op: "wait", milliseconds: 25 },
      { op: "wait", milliseconds: 25 },
    ]);
    expect(observed).toEqual([
      "original bytes\n",
      "original bytes\n",
      "original bytes\n",
      "original bytes\n",
    ]);
    expect(readFileSync(dest, "utf8")).toBe(`${JSON.stringify(value, null, 2)}\n`);
    expect(readdirSync(store.dir)).toEqual(["notes.json"]);
  });

  it("exhausts the budget with five attempts, four 25 ms waits, and the first error by identity", () => {
    const codes = ["EPERM", "EACCES", "EBUSY", "EPERM", "EACCES"] as const;
    const errors = codes.map((code, i) => withCode(code, `transient failure ${i}`));
    const observed: string[] = [];
    const { io, calls } = scriptedIo(
      errors.map((error) => ({ error })),
      (call) => observed.push(readFileSync(call.destination!, "utf8")),
    );
    const store = createRunStore(freshDir(), io);
    const dest = join(store.dir, "notes.json");
    writeFileSync(dest, "original bytes\n", "utf8");

    const thrown = expectThrows(() => store.write("notes.json", { ok: true }));
    expect(thrown).toBe(errors[0]);
    expect(renamedCalls(calls)).toHaveLength(5);
    expect(waitedCalls(calls)).toEqual([
      { op: "wait", milliseconds: 25 },
      { op: "wait", milliseconds: 25 },
      { op: "wait", milliseconds: 25 },
      { op: "wait", milliseconds: 25 },
    ]);
    expect(observed).toEqual([
      "original bytes\n",
      "original bytes\n",
      "original bytes\n",
      "original bytes\n",
      "original bytes\n",
    ]);
    expect(readFileSync(dest, "utf8")).toBe("original bytes\n");
    expect(readdirSync(store.dir).sort()).toEqual(["notes.json", "notes.json.tmp"]);
  });

  it("does not retry an ENOENT rename and throws the exact error", () => {
    const root = freshDir();
    const error = withCode("ENOENT", "no such file");
    const { io, calls } = scriptedIo([{ error }]);
    const store = createRunStore(root, io);
    const dest = join(store.dir, "notes.json");
    writeFileSync(dest, "original bytes\n", "utf8");

    expect(expectThrows(() => store.write("notes.json", { ok: true }))).toBe(error);
    expect(calls).toEqual([{ op: "rename", source: `${dest}.tmp`, destination: dest }]);
    expect(readFileSync(dest, "utf8")).toBe("original bytes\n");
    expect(readdirSync(store.dir).sort()).toEqual(["notes.json", "notes.json.tmp"]);
  });

  it("does not retry an EIO rename and throws the exact error", () => {
    const root = freshDir();
    const error = withCode("EIO", "io failure");
    const { io, calls } = scriptedIo([{ error }]);
    const store = createRunStore(root, io);
    const dest = join(store.dir, "notes.json");
    writeFileSync(dest, "original bytes\n", "utf8");

    expect(expectThrows(() => store.write("notes.json", { ok: true }))).toBe(error);
    expect(calls).toEqual([{ op: "rename", source: `${dest}.tmp`, destination: dest }]);
    expect(readFileSync(dest, "utf8")).toBe("original bytes\n");
    expect(readdirSync(store.dir).sort()).toEqual(["notes.json", "notes.json.tmp"]);
  });

  it("does not retry an error without a recognized code and throws the exact error", () => {
    const root = freshDir();
    const error = new Error("unlabeled failure");
    const { io, calls } = scriptedIo([{ error }]);
    const store = createRunStore(root, io);
    const dest = join(store.dir, "notes.json");
    writeFileSync(dest, "original bytes\n", "utf8");

    expect(expectThrows(() => store.write("notes.json", { ok: true }))).toBe(error);
    expect(calls).toEqual([{ op: "rename", source: `${dest}.tmp`, destination: dest }]);
    expect(readFileSync(dest, "utf8")).toBe("original bytes\n");
    expect(readdirSync(store.dir).sort()).toEqual(["notes.json", "notes.json.tmp"]);
  });

  it("stops immediately on a non-transient failure after a transient one", () => {
    const transient = withCode("EPERM", "transient failure");
    const fatal = withCode("EIO", "fatal failure");
    const observed: string[] = [];
    const { io, calls } = scriptedIo(
      [{ error: transient }, { error: fatal }],
      (call) => observed.push(readFileSync(call.destination!, "utf8")),
    );
    const store = createRunStore(freshDir(), io);
    const dest = join(store.dir, "notes.json");
    writeFileSync(dest, "original bytes\n", "utf8");

    expect(expectThrows(() => store.write("notes.json", { ok: true }))).toBe(fatal);
    expect(observed).toEqual(["original bytes\n", "original bytes\n"]);
    expect(calls).toEqual([
      { op: "rename", source: `${dest}.tmp`, destination: dest },
      { op: "wait", milliseconds: 25 },
      { op: "rename", source: `${dest}.tmp`, destination: dest },
    ]);
    expect(readFileSync(dest, "utf8")).toBe("original bytes\n");
    expect(readdirSync(store.dir).sort()).toEqual(["notes.json", "notes.json.tmp"]);
  });

  it("routes writeState through the same rename retry path", () => {
    const first = withCode("EPERM", "transient failure");
    const { io, calls } = scriptedIo(
      Array.from({ length: 5 }, () => ({ error: first })),
    );
    const store = createRunStore(freshDir(), io);

    expect(expectThrows(() => store.writeState(state()))).toBe(first);
    const dest = join(store.dir, "state.json");
    const renames = renamedCalls(calls);
    expect(renames).toHaveLength(5);
    for (const call of renames) {
      expect(call.source).toBe(`${dest}.tmp`);
      expect(call.destination).toBe(dest);
    }
    expect(waitedCalls(calls)).toHaveLength(4);
  });

  it("does not retry when the temporary write itself fails", () => {
    const { io, calls } = scriptedIo([{ ok: true }]);
    const store = createRunStore(freshDir(), io);
    // Block the fixed sibling path with a directory so writeFileSync fails
    // before the rename path is reached.
    mkdirSync(join(store.dir, "notes.json.tmp"));

    expect(() => store.write("notes.json", { ok: true })).toThrow();
    expect(calls).toEqual([]);
  });
});
