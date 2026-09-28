/**
 * autonomy-v1-006 pristine candidate fixture: nullish filtering.
 *
 * The exported {@link filterDefined} intentionally carries the truthiness
 * defect that is the subject of this benchmark case: it keeps only the truthy
 * entries of `values`, so in addition to `null` and `undefined` it also
 * drops legitimate falsy values such as `0`, `false`, and `''`. For example
 * `filterDefined([1, null, 0, false, '', 'a', undefined])` returns
 * `[1, 'a']` instead of `[1, 0, false, '', 'a']`. The relative order of the
 * retained values and the no-mutation guarantee are already correct in this
 * pristine source: the result is a fresh array built in input order and the
 * supplied array is never modified. The function is pure: it uses no
 * randomness, no I/O, and no other side effects.
 */
export function filterDefined<T>(values: readonly (T | null | undefined)[]): T[] {
  const result: T[] = [];
  for (const value of values) {
    if (value) {
      result.push(value);
    }
  }
  return result;
}
