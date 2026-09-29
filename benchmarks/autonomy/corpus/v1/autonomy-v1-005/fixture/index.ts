/**
 * autonomy-v1-005 pristine candidate fixture: first-occurrence deduplication.
 *
 * The exported {@link unique} intentionally carries the ordering defect that
 * is the subject of this benchmark case: it deduplicates `values` into a new
 * array of first occurrences and then sorts that result, so
 * `unique(["b", "a", "b"])` returns `["a", "b"]` in sorted order instead of
 * preserving the first-occurrence order `["b", "a"]`. Deduplication, exact
 * case-sensitive comparison, and the no-mutation guarantee are already
 * correct in this pristine source. The function is pure: it uses no
 * randomness, no I/O, and no other side effects.
 */
export function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  result.sort();
  return result;
}
