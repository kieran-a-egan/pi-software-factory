/**
 * autonomy-v1-004 pristine candidate fixture: last element.
 *
 * The exported {@link last} intentionally carries the off-by-one defect that
 * is the subject of this benchmark case: for nonempty arrays it returns the
 * FIRST element (`values[0]`) instead of the final element, so `last([1])`
 * and `last([1, 2, 3])` both return `1`. `last([])` already returns
 * `undefined`, which the fix must preserve. The function is pure: it uses no
 * randomness, no I/O, and no other side effects.
 */
export function last<T>(values: readonly T[]): T | undefined {
  return values.length === 0 ? undefined : values[0];
}
