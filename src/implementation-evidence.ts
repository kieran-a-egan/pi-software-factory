import { pathsOverlap } from "./parallel.js";
import type { ImplementationUnit, ScoutResult } from "./types.js";

function matchesAny(path: string, expected: string[]): boolean {
  return expected.some((entry) => pathsOverlap(path, entry));
}

function cloneScout(scout: ScoutResult): ScoutResult {
  return {
    summary: scout.summary,
    files: scout.files.map((file) => ({ ...file })),
    symbols: scout.symbols.map((symbol) => ({ ...symbol })),
    relationships: [...scout.relationships],
    constraints: [...scout.constraints],
    tests: [...scout.tests],
    unknowns: [...scout.unknowns],
    recommendedReads: [...scout.recommendedReads],
  };
}

/**
 * Selects the scout evidence that is deterministically useful for a single
 * implementation unit.
 *
 * Structured `files` and `symbols` are filtered by whether their path overlaps
 * any `filesExpected` entry (via existing `pathsOverlap` semantics). The
 * free-text fields (`summary`, `relationships`, `constraints`, `tests`,
 * `unknowns`, `recommendedReads`) lack reliable structured path metadata and
 * are always retained in original order.
 *
 * If `filesExpected` is absent/empty, or no file or symbol matches, the full
 * scout evidence is returned. Otherwise only the filtered structured
 * collections are retained. The result is always a fresh copy: neither the
 * input scout nor its arrays/records are mutated.
 */
export function selectImplementationEvidence(
  scout: ScoutResult,
  unit: ImplementationUnit,
): ScoutResult {
  const expected = unit.filesExpected ?? [];
  if (expected.length === 0) return cloneScout(scout);

  const files = scout.files
    .filter((file) => matchesAny(file.path, expected))
    .map((file) => ({ ...file }));
  const symbols = scout.symbols
    .filter((symbol) => matchesAny(symbol.path, expected))
    .map((symbol) => ({ ...symbol }));

  if (files.length === 0 && symbols.length === 0) return cloneScout(scout);

  return {
    summary: scout.summary,
    files,
    symbols,
    relationships: [...scout.relationships],
    constraints: [...scout.constraints],
    tests: [...scout.tests],
    unknowns: [...scout.unknowns],
    recommendedReads: [...scout.recommendedReads],
  };
}
