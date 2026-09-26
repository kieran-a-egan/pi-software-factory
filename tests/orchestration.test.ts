import { describe, expect, it } from "vitest";

import {
  implementationGraphIssue,
  readyImplementationUnits,
  selectParallelUnits,
} from "../src/orchestration.js";
import type { ImplementationUnit } from "../src/types.js";

type UnitOverrides = Partial<Omit<ImplementationUnit, "id" | "objective">> & {
  objective?: string;
};

function makeUnit(id: string, overrides: UnitOverrides = {}): ImplementationUnit {
  return {
    id,
    objective: overrides.objective ?? `objective for ${id}`,
    rationale: overrides.rationale,
    filesExpected: overrides.filesExpected,
    acceptance: overrides.acceptance ?? [`acceptance for ${id}`],
    constraints: overrides.constraints ?? [],
    dependsOn: overrides.dependsOn,
  };
}

function allPending(units: ImplementationUnit[]): Set<string> {
  return new Set(units.map((unit) => unit.id));
}

describe("implementationGraphIssue", () => {
  it("returns undefined for an empty plan", () => {
    expect(implementationGraphIssue([])).toBeUndefined();
  });

  it("returns undefined for unique independent roots", () => {
    const units = [makeUnit("zeta"), makeUnit("alpha"), makeUnit("mid")];
    expect(implementationGraphIssue(units)).toBeUndefined();
  });

  it("returns undefined for a dependency chain", () => {
    const units = [
      makeUnit("a"),
      makeUnit("b", { dependsOn: ["a"] }),
      makeUnit("c", { dependsOn: ["b"] }),
    ];
    expect(implementationGraphIssue(units)).toBeUndefined();
  });

  it("returns undefined for a diamond dependency graph", () => {
    const units = [
      makeUnit("root"),
      makeUnit("left", { dependsOn: ["root"] }),
      makeUnit("right", { dependsOn: ["root"] }),
      makeUnit("join", { dependsOn: ["left", "right"] }),
    ];
    expect(implementationGraphIssue(units)).toBeUndefined();
  });

  it("returns undefined for disconnected DAGs", () => {
    const units = [
      makeUnit("a1"),
      makeUnit("a2", { dependsOn: ["a1"] }),
      makeUnit("b1"),
      makeUnit("b2", { dependsOn: ["b1"] }),
      makeUnit("b3", { dependsOn: ["b1", "b2"] }),
    ];
    expect(implementationGraphIssue(units)).toBeUndefined();
  });

  it("reports duplicate ids with the first duplicated id in input order", () => {
    const units = [
      makeUnit("x"),
      makeUnit("y", { dependsOn: ["x"] }),
      makeUnit("x", { dependsOn: ["y"] }),
    ];
    expect(implementationGraphIssue(units)).toBe(
      "duplicate implementation unit id: x",
    );
  });

  it("prefers duplicate id diagnostics over unknown dependency diagnostics", () => {
    const units = [
      makeUnit("x"),
      makeUnit("y", { dependsOn: ["missing"] }),
      makeUnit("x"),
    ];
    expect(implementationGraphIssue(units)).toBe(
      "duplicate implementation unit id: x",
    );
  });

  it("reports unknown dependencies for the first affected unit in input order", () => {
    const units = [
      makeUnit("ok"),
      makeUnit("second", { dependsOn: ["ok", "ghost"] }),
      makeUnit("first-bad", { dependsOn: ["phantom"] }),
    ];
    expect(implementationGraphIssue(units)).toBe(
      "implementation unit second depends on unknown unit ghost",
    );
  });

  it("reports a self-cycle", () => {
    const units = [makeUnit("loop", { dependsOn: ["loop"] })];
    expect(implementationGraphIssue(units)).toBe(
      "implementation dependency graph contains a cycle involving: loop",
    );
  });

  it("reports a multi-unit cycle with the remaining ids in input order", () => {
    const units = [
      makeUnit("root"),
      makeUnit("a", { dependsOn: ["b"] }),
      makeUnit("b", { dependsOn: ["a"] }),
    ];
    expect(implementationGraphIssue(units)).toBe(
      "implementation dependency graph contains a cycle involving: a, b",
    );
  });

  it("includes unresolved downstream units of a cycle in the diagnostic", () => {
    const units = [
      makeUnit("root"),
      makeUnit("a", { dependsOn: ["b"] }),
      makeUnit("b", { dependsOn: ["a"] }),
      makeUnit("downstream", { dependsOn: ["b"] }),
    ];
    expect(implementationGraphIssue(units)).toBe(
      "implementation dependency graph contains a cycle involving: a, b, downstream",
    );
  });

  it("does not mutate the input plan", () => {
    const units = [
      makeUnit("a"),
      makeUnit("b", { dependsOn: ["a"] }),
      makeUnit("a"),
    ];
    const snapshot = structuredClone(units);
    implementationGraphIssue(units);
    expect(units).toEqual(snapshot);
  });
});

describe("readyImplementationUnits", () => {
  it("returns an empty array for an empty unit list", () => {
    expect(
      readyImplementationUnits([], new Set<string>(), new Set<string>()),
    ).toEqual([]);
  });

  it("includes only pending units", () => {
    const units = [makeUnit("a"), makeUnit("b"), makeUnit("c")];
    const pending = new Set(["a", "c"]);
    const completed = new Set(["a", "b", "c"]);
    expect(readyImplementationUnits(units, pending, completed).map((u) => u.id)).toEqual([
      "a",
      "c",
    ]);
  });

  it("treats omitted dependencies as satisfied", () => {
    const units = [makeUnit("a")];
    const ready = readyImplementationUnits(units, new Set(["a"]), new Set());
    expect(ready.map((u) => u.id)).toEqual(["a"]);
  });

  it("treats explicit empty dependencies as satisfied", () => {
    const units = [makeUnit("a", { dependsOn: [] })];
    const ready = readyImplementationUnits(units, new Set(["a"]), new Set());
    expect(ready.map((u) => u.id)).toEqual(["a"]);
  });

  it("excludes units whose dependencies are only partially completed", () => {
    const units = [
      makeUnit("a"),
      makeUnit("b"),
      makeUnit("c", { dependsOn: ["a", "b"] }),
    ];
    const ready = readyImplementationUnits(
      units,
      allPending(units),
      new Set(["a"]),
    );
    expect(ready.map((u) => u.id)).toEqual(["a", "b"]);
  });

  it("includes units whose dependencies are fully completed", () => {
    const units = [
      makeUnit("a"),
      makeUnit("b"),
      makeUnit("c", { dependsOn: ["a", "b"] }),
    ];
    const ready = readyImplementationUnits(
      units,
      allPending(units),
      new Set(["a", "b"]),
    );
    expect(ready.map((u) => u.id)).toEqual(["a", "b", "c"]);
  });

  it("excludes non-pending units even when all dependencies are completed", () => {
    const units = [
      makeUnit("a"),
      makeUnit("b", { dependsOn: ["a"] }),
    ];
    const ready = readyImplementationUnits(
      units,
      new Set(["a"]),
      new Set(["a", "b"]),
    );
    expect(ready.map((u) => u.id)).toEqual(["a"]);
  });

  it("preserves input order of ready units", () => {
    const units = [
      makeUnit("third", { dependsOn: ["done"] }),
      makeUnit("first", { dependsOn: ["done"] }),
      makeUnit("second"),
    ];
    const ready = readyImplementationUnits(
      units,
      allPending(units),
      new Set(["done"]),
    );
    expect(ready.map((u) => u.id)).toEqual(["third", "first", "second"]);
  });

  it("does not mutate inputs", () => {
    const units = [
      makeUnit("a"),
      makeUnit("b", { dependsOn: ["a"] }),
    ];
    const pending = new Set(units.map((unit) => unit.id));
    const completed = new Set<string>();
    const unitSnapshot = structuredClone(units);
    const pendingSnapshot = new Set(pending);
    readyImplementationUnits(units, pending, completed);
    expect(units).toEqual(unitSnapshot);
    expect(pending).toEqual(pendingSnapshot);
    expect(completed).toEqual(new Set<string>());
  });
});

describe("selectParallelUnits", () => {
  it("returns an empty array for empty input", () => {
    expect(selectParallelUnits([], 3)).toEqual([]);
  });

  it("caps selection at one unit", () => {
    const units = [
      makeUnit("a", { filesExpected: ["src/a.ts"], dependsOn: [] }),
      makeUnit("b", { filesExpected: ["src/b.ts"], dependsOn: [] }),
      makeUnit("c", { filesExpected: ["src/c.ts"], dependsOn: [] }),
    ];
    expect(selectParallelUnits(units, 1).map((u) => u.id)).toEqual(["a"]);
  });

  it("caps selection at two units", () => {
    const units = [
      makeUnit("a", { filesExpected: ["src/a.ts"], dependsOn: [] }),
      makeUnit("b", { filesExpected: ["src/b.ts"], dependsOn: [] }),
      makeUnit("c", { filesExpected: ["src/c.ts"], dependsOn: [] }),
    ];
    expect(selectParallelUnits(units, 2).map((u) => u.id)).toEqual(["a", "b"]);
  });

  it("selects disjoint scopes in input order", () => {
    const units = [
      makeUnit("a", { filesExpected: ["src/a.ts"], dependsOn: [] }),
      makeUnit("b", {
        filesExpected: ["src/b.ts", "src/b2.ts"],
        dependsOn: [],
      }),
    ];
    expect(selectParallelUnits(units, 4).map((u) => u.id)).toEqual(["a", "b"]);
  });

  it("skips units with identical files", () => {
    const units = [
      makeUnit("a", { filesExpected: ["src/shared.ts"], dependsOn: [] }),
      makeUnit("b", { filesExpected: ["src/shared.ts"], dependsOn: [] }),
      makeUnit("c", { filesExpected: ["src/other.ts"], dependsOn: [] }),
    ];
    expect(selectParallelUnits(units, 4).map((u) => u.id)).toEqual(["a", "c"]);
  });

  it("skips a child scope nested inside an already selected parent scope", () => {
    const units = [
      makeUnit("parent", { filesExpected: ["src"], dependsOn: [] }),
      makeUnit("child", { filesExpected: ["src/a.ts"], dependsOn: [] }),
    ];
    expect(selectParallelUnits(units, 2).map((u) => u.id)).toEqual(["parent"]);
  });

  it("skips a parent scope overlapping an already selected child scope", () => {
    const units = [
      makeUnit("child", { filesExpected: ["src/a.ts"], dependsOn: [] }),
      makeUnit("parent", { filesExpected: ["src"], dependsOn: [] }),
    ];
    expect(selectParallelUnits(units, 2).map((u) => u.id)).toEqual(["child"]);
  });

  it("selects sibling lexical-prefix scopes that do not overlap", () => {
    const units = [
      makeUnit("a", { filesExpected: ["src/a/b.ts"], dependsOn: [] }),
      makeUnit("b", { filesExpected: ["src/a/bc.ts"], dependsOn: [] }),
    ];
    expect(selectParallelUnits(units, 2).map((u) => u.id)).toEqual(["a", "b"]);
  });

  it("treats Windows-style and forward-slash paths as overlapping", () => {
    const units = [
      makeUnit("a", { filesExpected: ["src\\a.ts"], dependsOn: [] }),
      makeUnit("b", { filesExpected: ["src/a.ts"], dependsOn: [] }),
    ];
    expect(selectParallelUnits(units, 2).map((u) => u.id)).toEqual(["a"]);
  });

  it("skips a multi-scope unit when only one scope conflicts", () => {
    const units = [
      makeUnit("a", {
        filesExpected: ["lib/a.ts", "lib/b.ts"],
        dependsOn: [],
      }),
      makeUnit("b", {
        filesExpected: ["lib/c.ts", "lib/a.ts"],
        dependsOn: [],
      }),
      makeUnit("c", { filesExpected: ["lib/d.ts"], dependsOn: [] }),
    ];
    expect(selectParallelUnits(units, 4).map((u) => u.id)).toEqual(["a", "c"]);
  });

  it("selects a later eligible unit after a conflicting candidate is skipped", () => {
    const units = [
      makeUnit("a", { filesExpected: ["lib/a.ts"], dependsOn: [] }),
      makeUnit("b", {
        filesExpected: ["lib/a.ts", "lib/b.ts"],
        dependsOn: [],
      }),
      makeUnit("c", { filesExpected: ["lib/c.ts"], dependsOn: [] }),
    ];
    expect(selectParallelUnits(units, 3).map((u) => u.id)).toEqual(["a", "c"]);
  });

  it("skips units with omitted or empty filesExpected", () => {
    const units = [
      makeUnit("omitted-files", { dependsOn: [] }),
      makeUnit("empty-files", { filesExpected: [], dependsOn: [] }),
      makeUnit("eligible", {
        filesExpected: ["src/eligible.ts"],
        dependsOn: [],
      }),
    ];
    expect(selectParallelUnits(units, 4).map((u) => u.id)).toEqual(["eligible"]);
  });

  it("skips units with omitted dependsOn but accepts explicit empty dependsOn", () => {
    const units = [
      makeUnit("omitted-deps", { filesExpected: ["src/a.ts"] }),
      makeUnit("explicit-deps", {
        filesExpected: ["src/b.ts"],
        dependsOn: [],
      }),
    ];
    expect(selectParallelUnits(units, 2).map((u) => u.id)).toEqual([
      "explicit-deps",
    ]);
  });

  it("preserves stable greedy input order", () => {
    const units = [
      makeUnit("z", { filesExpected: ["s/z.ts"], dependsOn: [] }),
      makeUnit("m", { filesExpected: ["s/m.ts"], dependsOn: [] }),
      makeUnit("a", { filesExpected: ["s/a.ts"], dependsOn: [] }),
      makeUnit("q", { filesExpected: ["s/q.ts"], dependsOn: [] }),
    ];
    expect(selectParallelUnits(units, 2).map((u) => u.id)).toEqual(["z", "m"]);
    expect(selectParallelUnits(units, 4).map((u) => u.id)).toEqual([
      "z",
      "m",
      "a",
      "q",
    ]);
  });

  it("does not mutate the input list", () => {
    const units = [
      makeUnit("a", { filesExpected: ["src/a.ts"], dependsOn: [] }),
      makeUnit("b", { filesExpected: ["src/a.ts"], dependsOn: [] }),
    ];
    const snapshot = structuredClone(units);
    selectParallelUnits(units, 2);
    expect(units).toEqual(snapshot);
  });
});

describe("composed orchestration scenario", () => {
  it("validates a plan, filters readiness, selects a safe batch, and gates dependents on completion", () => {
    const plan = [
      makeUnit("a", { filesExpected: ["src/a.ts"], dependsOn: [] }),
      makeUnit("b", { filesExpected: ["src/b.ts"], dependsOn: [] }),
      makeUnit("c", { filesExpected: ["src/c.ts"], dependsOn: ["a"] }),
      makeUnit("d", { filesExpected: ["src/d.ts"], dependsOn: ["b", "c"] }),
    ];
    const planSnapshot = structuredClone(plan);

    expect(implementationGraphIssue(plan)).toBeUndefined();

    const pending = new Set(plan.map((unit) => unit.id));
    const completed = new Set<string>();

    const initialReady = readyImplementationUnits(plan, pending, completed);
    expect(initialReady.map((unit) => unit.id)).toEqual(["a", "b"]);

    const batch = selectParallelUnits(initialReady, 2);
    expect(batch.map((unit) => unit.id)).toEqual(["a", "b"]);

    // Dependent units stay out of the ready set until their dependencies
    // are recorded as completed.
    expect(
      readyImplementationUnits(plan, pending, completed).map((unit) => unit.id),
    ).toEqual(["a", "b"]);

    for (const unit of batch) {
      pending.delete(unit.id);
      completed.add(unit.id);
    }

    const secondReady = readyImplementationUnits(plan, pending, completed);
    expect(secondReady.map((unit) => unit.id)).toEqual(["c"]);

    const secondBatch = selectParallelUnits(secondReady, 2);
    expect(secondBatch.map((unit) => unit.id)).toEqual(["c"]);
    for (const unit of secondBatch) {
      pending.delete(unit.id);
      completed.add(unit.id);
    }

    const finalReady = readyImplementationUnits(plan, pending, completed);
    expect(finalReady.map((unit) => unit.id)).toEqual(["d"]);

    expect(plan).toEqual(planSnapshot);
  });
});
