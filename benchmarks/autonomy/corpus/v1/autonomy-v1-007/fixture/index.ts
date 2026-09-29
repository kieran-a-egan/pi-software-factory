/**
 * autonomy-v1-007 pristine candidate fixture: leading-prefix stripping.
 *
 * The exported {@link stripPrefix} intentionally carries the first-occurrence
 * defect that is the subject of this benchmark case: it removes the first
 * literal occurrence of `prefix` anywhere in `value`, not only a leading
 * one. For example `stripPrefix('prevalue', 'pre')` returns `value`, but
 * `stripPrefix('valuepre', 'pre')` returns `value` instead of leaving
 * `'valuepre'` unchanged, and `stripPrefix('xprevalue', 'pre')` returns
 * `xvalue`. The remaining pristine behavior is already correct: an absent
 * prefix and an empty prefix leave the input unchanged, a repeated leading
 * prefix loses only the first occurrence (`stripPrefix('preprevalue', 'pre')`
 * returns `prevalue`), matching is exact and case-sensitive, and neither
 * argument is trimmed or normalized. The function is pure: it uses no
 * randomness, no I/O, and no other side effects.
 */
export function stripPrefix(value: string, prefix: string): string {
  return value.replace(prefix, "");
}
