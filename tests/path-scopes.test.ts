import { describe, expect, it } from "vitest";
import {
  changedPathsOutsideExpected,
  pathsOverlap,
} from "../src/parallel.js";
import { unexpectedReportedFiles } from "../src/orchestration.js";
import type { WorkerReport } from "../src/types.js";

function report(changedFiles: string[]): WorkerReport {
  return {
    unitId: "unit-under-test",
    summary: "fixture",
    changedFiles,
    testsRun: [],
    decisions: [],
    blockers: [],
    remainingWork: [],
    notes: [],
  };
}

describe("pathsOverlap", () => {
  it.each([
    // Equality
    { a: "src/parallel.ts", b: "src/parallel.ts", expected: true },
    { a: "package.json", b: "package.json", expected: true },
    // Symmetry (both directions are exercised explicitly)
    { a: "src", b: "src/parallel.ts", expected: true },
    { a: "src/parallel.ts", b: "src", expected: true },
    // Ancestor/descendant at arbitrary depth
    { a: "src", b: "src/a/b/c.ts", expected: true },
    { a: "src/a/b/c.ts", b: "src/a", expected: true },
    { a: "src/a", b: "src/a/b", expected: true },
    // Unrelated paths
    { a: "src/parallel.ts", b: "src/controller.ts", expected: false },
    { a: "src", b: "tests/parallel.test.ts", expected: false },
    // Sibling prefix boundaries: sharing a prefix is not overlap
    { a: "src", b: "src2/other.ts", expected: false },
    { a: "src2/other.ts", b: "src", expected: false },
    { a: "a/b", b: "a/bcd", expected: false },
    { a: "a/bcd", b: "a/b", expected: false },
    // Backslashes are normalized to forward slashes
    { a: "src\\parallel.ts", b: "src/parallel.ts", expected: true },
    { a: "src\\a\\b.ts", b: "src/a", expected: true },
    // Leading ./ is stripped before comparison
    { a: "./src/parallel.ts", b: "src/parallel.ts", expected: true },
    { a: "./src", b: "src/parallel.ts", expected: true },
    // Trailing slash is stripped before comparison
    { a: "src/", b: "src", expected: true },
    { a: "tests/", b: "tests/x.test.ts", expected: true },
    // Either operand empty (after normalization) overlaps everything
    { a: "", b: "src/parallel.ts", expected: true },
    { a: "src/parallel.ts", b: "", expected: true },
    { a: "", b: "", expected: true },
    { a: "./", b: "src/parallel.ts", expected: true },
    // Case sensitivity is pinned: differing case is not overlap
    { a: "SRC/parallel.ts", b: "src/parallel.ts", expected: false },
    { a: "src/Parallel.ts", b: "src/parallel.ts", expected: false },
    // Literal matching is pinned: glob syntax has no special meaning
    { a: "src/*.ts", b: "src/parallel.ts", expected: false },
    { a: "src/parallel.ts", b: "src/*.ts", expected: false },
    { a: "src/**", b: "src/parallel.ts", expected: false },
  ])("pathsOverlap($a, $b) === $expected", ({ a, b, expected }) => {
    expect(pathsOverlap(a, b)).toBe(expected);
  });
});

describe("changedPathsOutsideExpected", () => {
  it.each([
    // Missing or empty declarations: every normalized changed path is outside
    {
      name: "missing filesExpected returns all normalized changed paths",
      changed: ["src\\a.ts", "./b/", "c"],
      filesExpected: undefined,
      expected: ["src/a.ts", "b", "c"],
    },
    {
      name: "empty filesExpected returns all normalized changed paths",
      changed: ["src\\a.ts", "./b/", "c"],
      filesExpected: [],
      expected: ["src/a.ts", "b", "c"],
    },
    // Empty changes
    {
      name: "empty changed paths return []",
      changed: [],
      filesExpected: ["src"],
      expected: [],
    },
    // Fully allowed
    {
      name: "fully allowed changes return []",
      changed: ["src/a.ts", "src/b/c.ts"],
      filesExpected: ["src"],
      expected: [],
    },
    // Mixed scopes
    {
      name: "mixed scopes return only the disallowed paths",
      changed: ["src/a.ts", "tests/b.test.ts"],
      filesExpected: ["src"],
      expected: ["tests/b.test.ts"],
    },
    // Multiple allowed prefixes
    {
      name: "multiple allowed prefixes cover several changed paths",
      changed: ["src/a.ts", "src/x/b.ts", "other/c.ts"],
      filesExpected: ["src/a.ts", "src/x"],
      expected: ["other/c.ts"],
    },
    // Normalization of changed paths and expected entries
    {
      name: "backslashes and ./ prefixes in changes are normalized before comparison",
      changed: ["src\\a.ts", "./src/a.ts", "SRC\\b.ts"],
      filesExpected: ["src/a.ts", "SRC/b.ts"],
      expected: [],
    },
  ])("$name", ({ changed, filesExpected, expected }) => {
    expect(changedPathsOutsideExpected(changed, filesExpected)).toEqual(
      expected,
    );
  });

  it("preserves output order and duplicates", () => {
    expect(
      changedPathsOutsideExpected(["z.ts", "a.ts", "a.ts"], ["none.ts"]),
    ).toEqual(["z.ts", "a.ts", "a.ts"]);
  });

  it("does not mutate its input arrays", () => {
    const changed = ["src\\a.ts", "tests/b.test.ts"];
    const filesExpected = ["./src/"];
    const changedCopy = [...changed];
    const expectedCopy = [...filesExpected];
    changedPathsOutsideExpected(changed, filesExpected);
    expect(changed).toEqual(changedCopy);
    expect(filesExpected).toEqual(expectedCopy);
  });
});

describe("unexpectedReportedFiles", () => {
  it.each([
    // Allowed report paths
    {
      name: "allowed report paths return []",
      assignment: { filesExpected: ["src/parallel.ts"] },
      changed: ["src/parallel.ts"],
      expected: [],
    },
    // Unexpected report paths
    {
      name: "unexpected report paths are returned",
      assignment: { filesExpected: ["src/parallel.ts"] },
      changed: ["src/other.ts"],
      expected: ["src/other.ts"],
    },
    {
      name: "mixed report returns only unexpected paths",
      assignment: { filesExpected: ["src", "tests/path-scopes.test.ts"] },
      changed: ["src/a.ts", "src/b/c.ts", "stray/x.ts"],
      expected: ["stray/x.ts"],
    },
    // Missing/empty declarations return []
    {
      name: "missing filesExpected returns []",
      assignment: {},
      changed: ["src/a.ts", "b.ts"],
      expected: [],
    },
    {
      name: "empty filesExpected returns []",
      assignment: { filesExpected: [] },
      changed: ["src/a.ts", "b.ts"],
      expected: [],
    },
    {
      name: "non-array filesExpected returns []",
      assignment: { filesExpected: "src/parallel.ts" },
      changed: ["src/parallel.ts"],
      expected: [],
    },
    // Windows normalization of reported paths
    {
      name: "backslash report paths are normalized before comparison",
      assignment: { filesExpected: ["src/parallel.ts"] },
      changed: ["src\\parallel.ts", "src\\other.ts"],
      expected: ["src/other.ts"],
    },
  ])("$name", ({ assignment, changed, expected }) => {
    expect(unexpectedReportedFiles(assignment, report(changed))).toEqual(
      expected,
    );
  });

  it("preserves a trailing slash on returned report paths, unlike changedPathsOutsideExpected", () => {
    // unexpectedReportedFiles strips a leading ./ but leaves trailing slashes
    // intact in its output; changedPathsOutsideExpected normalizes them away.
    expect(unexpectedReportedFiles({ filesExpected: ["other"] }, report(["src/"])))
      .toEqual(["src/"]);
    expect(changedPathsOutsideExpected(["src/"], ["other"])).toEqual(["src"]);
  });

  it("still matches a trailing-slash declaration against nested report paths", () => {
    expect(
      unexpectedReportedFiles({ filesExpected: ["src/"] }, report(["src/parallel.ts"])),
    ).toEqual([]);
  });

  it("preserves output order and duplicates for unexpected report paths", () => {
    expect(
      unexpectedReportedFiles({ filesExpected: ["keep.ts"] }, report(["z.ts", "a.ts", "a.ts"])),
    ).toEqual(["z.ts", "a.ts", "a.ts"]);
  });

  it("does not mutate the report fixture", () => {
    const changed = ["src\\a.ts", "tests/b.test.ts"];
    const fixture = report(changed);
    unexpectedReportedFiles({ filesExpected: ["src"] }, fixture);
    expect(fixture.changedFiles).toEqual(changed);
  });
});
