import { describe, expect, it } from "vitest";
import { selectImplementationEvidence } from "../src/implementation-evidence.js";
import type { ImplementationUnit, ScoutResult } from "../src/types.js";

function unit(filesExpected?: string[]): ImplementationUnit {
  return {
    id: "unit-under-test",
    objective: "unit under test",
    filesExpected,
    acceptance: [],
    constraints: [],
  };
}

function scout(overrides: Partial<ScoutResult> = {}): ScoutResult {
  return {
    summary: "repo summary",
    files: [
      { path: "src/parallel.ts", relevance: "path helpers" },
      { path: "src/controller.ts", relevance: "orchestration" },
      { path: "tests/parallel.test.ts", relevance: "coverage" },
    ],
    symbols: [
      { name: "pathsOverlap", path: "src/parallel.ts", relevance: "core matcher" },
      { name: "buildPrompt", path: "src/controller.ts", relevance: "prompt builder" },
    ],
    relationships: ["controller imports pathsOverlap"],
    constraints: ["no I/O in selector"],
    tests: ["vitest run"],
    unknowns: ["unresolved routing question"],
    recommendedReads: ["src/docs/architecture.md"],
    ...overrides,
  };
}

describe("selectImplementationEvidence matching and exclusion", () => {
  it("includes exact-match, directory-overlap, and descendant entries; excludes unrelated structured evidence", () => {
    const result = selectImplementationEvidence(
      scout(),
      unit(["src/parallel.ts", "tests/parallel.test.ts"]),
    );

    expect(result.files.map((f) => f.path)).toEqual([
      "src/parallel.ts",
      "tests/parallel.test.ts",
    ]);
    expect(result.symbols.map((s) => s.name)).toEqual(["pathsOverlap"]);
  });

  it("includes entries via directory and descendant overlap in either direction", () => {
    const result = selectImplementationEvidence(
      scout(),
      unit(["src"]),
    );

    // "src" overlaps src/parallel.ts and src/controller.ts (directory),
    // but not tests/parallel.test.ts (unrelated top-level dir).
    expect(result.files.map((f) => f.path)).toEqual([
      "src/parallel.ts",
      "src/controller.ts",
    ]);
    expect(result.symbols.map((s) => s.name)).toEqual([
      "pathsOverlap",
      "buildPrompt",
    ]);
  });

  it("does not treat sibling prefixes as overlap when another entry does match", () => {
    // "src/parallel" is a sibling prefix of "src/parallel.ts" (not an overlap),
    // while "src/controller.ts" is an exact match. Because a match exists, the
    // sibling is excluded rather than the evidence falling back to full.
    const result = selectImplementationEvidence(
      scout(),
      unit(["src/parallel", "src/controller.ts"]),
    );

    expect(result.files.map((f) => f.path)).toEqual(["src/controller.ts"]);
    expect(result.symbols.map((s) => s.name)).toEqual(["buildPrompt"]);
  });

  it("preserves existing normalization semantics (backslashes, leading ./)", () => {
    const source = scout({
      files: [
        { path: "src\\parallel.ts", relevance: "windows style" },
        { path: "./tests/parallel.test.ts", relevance: "leading dot" },
      ],
      symbols: [{ name: "s", path: "src\\parallel.ts", relevance: "sym" }],
    });
    const result = selectImplementationEvidence(source, unit(["src/parallel.ts", "tests/parallel.test.ts"]));

    expect(result.files.map((f) => f.path)).toEqual([
      "src\\parallel.ts",
      "./tests/parallel.test.ts",
    ]);
    expect(result.symbols.map((s) => s.name)).toEqual(["s"]);
  });
});

describe("selectImplementationEvidence free-text retention", () => {
  it("retains summary, relationships, constraints, tests, unknowns, recommendedReads even when they reference outside filesExpected", () => {
    const source = scout({
      relationships: ["depends on src/docs/architecture.md and src/external.ts"],
      recommendedReads: ["src/external.ts", "docs/design.md"],
      unknowns: ["does src/external.ts exist?"],
    });
    const result = selectImplementationEvidence(source, unit(["src/parallel.ts"]));

    expect(result.summary).toBe(source.summary);
    expect(result.relationships).toEqual(source.relationships);
    expect(result.constraints).toEqual(source.constraints);
    expect(result.tests).toEqual(source.tests);
    expect(result.unknowns).toEqual(source.unknowns);
    expect(result.recommendedReads).toEqual(source.recommendedReads);
    // Only the matching structured entries survive.
    expect(result.files.map((f) => f.path)).toEqual(["src/parallel.ts"]);
    expect(result.symbols.map((s) => s.name)).toEqual(["pathsOverlap"]);
  });
});

describe("selectImplementationEvidence fallback to full evidence", () => {
  it("returns the full scout evidence when filesExpected is missing", () => {
    const source = scout();
    const result = selectImplementationEvidence(source, unit(undefined));

    expect(result).toEqual(source);
    expect(result.files).not.toBe(source.files);
  });

  it("returns the full scout evidence when filesExpected is empty", () => {
    const source = scout();
    const result = selectImplementationEvidence(source, unit([]));

    expect(result).toEqual(source);
    expect(result.files).not.toBe(source.files);
  });

  it("returns the full scout evidence when a nonempty scope matches no file or symbol", () => {
    const source = scout();
    const result = selectImplementationEvidence(source, unit(["benchmarks/ignored.ts"]));

    expect(result).toEqual(source);
    expect(result.files.map((f) => f.path)).toEqual(
      source.files.map((f) => f.path),
    );
    expect(result.symbols.map((s) => s.name)).toEqual(
      source.symbols.map((s) => s.name),
    );
  });
});

describe("selectImplementationEvidence single-collection filtering", () => {
  it("keeps the non-matching collection filtered rather than independently falling back when only symbols match", () => {
    // No file path overlaps filesExpected; the single symbol does.
    const source = scout({
      files: [
        { path: "src/other-a.ts", relevance: "unrelated file" },
        { path: "src/other-b.ts", relevance: "unrelated file" },
      ],
      symbols: [{ name: "pathsOverlap", path: "src/parallel.ts", relevance: "core" }],
    });
    const result = selectImplementationEvidence(source, unit(["src/parallel.ts"]));

    // File collection has no match -> stays empty, does NOT fall back to
    // the unrelated files. The matching symbol is retained.
    expect(result.files).toEqual([]);
    expect(result.symbols.map((s) => s.name)).toEqual(["pathsOverlap"]);
  });

  it("keeps the non-matching collection filtered rather than independently falling back when only files match", () => {
    const source = scout({
      files: [
        { path: "src/controller.ts", relevance: "file match" },
        { path: "src/unrelated.ts", relevance: "unrelated file" },
      ],
      symbols: [{ name: "pathsOverlap", path: "src/parallel.ts", relevance: "unrelated sym" }],
    });
    const result = selectImplementationEvidence(source, unit(["src/controller.ts"]));

    // File has a match, symbol does not -> symbol collection stays empty,
    // it does NOT fall back to the unrelated symbol.
    expect(result.files.map((f) => f.path)).toEqual(["src/controller.ts"]);
    expect(result.symbols).toEqual([]);
  });
});

describe("selectImplementationEvidence determinism, order, and purity", () => {
  it("produces deterministic output and preserves source ordering", () => {
    const source = scout();
    const unitSpec = unit(["src/parallel.ts", "src", "tests/parallel.test.ts"]);

    const first = selectImplementationEvidence(source, unitSpec);
    const second = selectImplementationEvidence(source, unitSpec);

    expect(first).toEqual(second);
    // Order preserved from source: src/parallel.ts before tests/parallel.test.ts.
    // "src" overlaps both src/parallel.ts and src/controller.ts; source order
    // is preserved (src/parallel.ts, src/controller.ts, tests/parallel.test.ts).
    expect(first.files.map((f) => f.path)).toEqual([
      "src/parallel.ts",
      "src/controller.ts",
      "tests/parallel.test.ts",
    ]);
  });

  it("creates fresh arrays and records without mutating inputs (frozen)", () => {
    const source = scout();
    Object.freeze(source);
    for (const arr of [
      source.files,
      source.symbols,
      source.relationships,
      source.constraints,
      source.tests,
      source.unknowns,
      source.recommendedReads,
    ]) {
      Object.freeze(arr);
    }
    for (const file of source.files) Object.freeze(file);
    for (const symbol of source.symbols) Object.freeze(symbol);

    const result = selectImplementationEvidence(source, unit(["src/parallel.ts"]));

    expect(result.files).not.toBe(source.files);
    expect(result.symbols).not.toBe(source.symbols);
    expect(result.relationships).not.toBe(source.relationships);
    expect(result.constraints).not.toBe(source.constraints);
    expect(result.tests).not.toBe(source.tests);
    expect(result.unknowns).not.toBe(source.unknowns);
    expect(result.recommendedReads).not.toBe(source.recommendedReads);
    expect(result.files[0]).not.toBe(source.files[0]);
    expect(result.symbols[0]).not.toBe(source.symbols[0]);
    // Records carry the same content as their sources.
    expect(result.files[0]).toEqual(source.files[0]);
    expect(result.symbols[0]).toEqual(source.symbols[0]);
  });

  it("creates fresh arrays and records without mutating inputs (mutable snapshot)", () => {
    const source = scout();
    const snapshot = JSON.parse(JSON.stringify(source)) as ScoutResult;
    const result = selectImplementationEvidence(source, unit(["src"]));

    // Mutating the result must not affect the source.
    result.files.push({ path: "injected.ts", relevance: "x" });
    result.symbols.push({ name: "injected", path: "injected.ts", relevance: "x" });
    result.files[0].relevance = "mutated";

    expect(source.files).toHaveLength(3);
    expect(source.symbols).toHaveLength(2);
    expect(source.files[0].relevance).toBe("path helpers");
    // Still equal to the pristine snapshot for the unfiltered fields.
    expect(result.summary).toBe(snapshot.summary);
  });

  it("does not mutate the ImplementationUnit (frozen with snapshot)", () => {
    const source = scout();
    const unitSpec: ImplementationUnit = {
      id: "unit-under-test",
      objective: "unit under test",
      filesExpected: ["src/parallel.ts"],
      acceptance: ["acceptance item"],
      constraints: ["constraint item"],
    };
    Object.freeze(unitSpec);
    Object.freeze(unitSpec.filesExpected);
    Object.freeze(unitSpec.acceptance);
    Object.freeze(unitSpec.constraints);
    const unitSnapshot = JSON.parse(JSON.stringify(unitSpec)) as ImplementationUnit;

    selectImplementationEvidence(source, unitSpec);

    expect(unitSpec).toEqual(unitSnapshot);
    expect(unitSpec.filesExpected).toEqual(["src/parallel.ts"]);
  });

  it("does not mutate the ImplementationUnit (mutable snapshot)", () => {
    const source = scout();
    const unitSpec = unit(["src/parallel.ts", "src/controller.ts"]);
    unitSpec.acceptance = ["acceptance item"];
    unitSpec.constraints = ["constraint item"];
    const unitSnapshot = JSON.parse(JSON.stringify(unitSpec)) as ImplementationUnit;

    selectImplementationEvidence(source, unitSpec);

    expect(unitSpec).toEqual(unitSnapshot);
  });
});
