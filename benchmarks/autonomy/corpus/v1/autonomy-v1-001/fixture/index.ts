/**
 * autonomy-v1-001 pristine candidate fixture: arithmetic mean.
 *
 * The exported {@link mean} intentionally carries the empty-array defect that
 * is the subject of this benchmark case: `mean([])` returns `NaN` (0 divided
 * by 0) instead of the required 0. Nonempty arrays already produce correct
 * results. The function is pure: it uses no randomness, no I/O, and no other
 * side effects.
 */
export function mean(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}
