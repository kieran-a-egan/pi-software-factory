/**
 * autonomy-v1-009 pristine candidate fixture: inclusive-end slicing.
 *
 * The exported {@link sliceInclusive} intentionally carries the
 * exclusive-end defect that is the subject of this benchmark case: it
 * delegates to `Array.prototype.slice`, which treats `end` as exclusive, so
 * the element at the supplied end index is omitted from the result. For
 * example `sliceInclusive(['a', 'b', 'c', 'd'], 1, 2)` returns `['b']`
 * instead of `['b', 'c']`. The remaining pristine behavior is already
 * correct: the start index is inclusive, elements outside the requested
 * bounds are excluded, beyond-length ends are handled as in
 * `Array.prototype.slice`, and the result is a fresh array distinct from the
 * input while the supplied array is never mutated. The function is pure: it
 * uses no randomness, no I/O, and no other side effects.
 */
export function sliceInclusive<T>(values: readonly T[], start: number, end: number): T[] {
  return values.slice(start, end);
}
