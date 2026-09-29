/**
 * autonomy-v1-008 pristine candidate fixture: object-merge precedence.
 *
 * The exported {@link mergeOptions} intentionally carries the reversed-
 * precedence defect that is the subject of this benchmark case: it builds
 * the result from `overrides` first and then applies `defaults` on top, so
 * for a key present in both inputs the `defaults` value wins. For example
 * `mergeOptions({ theme: 'dark' }, { theme: 'light' })` returns
 * `{ theme: 'dark' }` instead of `{ theme: 'light' }`. The remaining
 * pristine behavior is already correct: keys present in only one input
 * survive with their original values, key matching is exact and
 * case-sensitive (`theme` and `Theme` are distinct keys), the result is a
 * fresh object distinct from both inputs, and neither input is mutated.
 * The function is pure: it uses no randomness, no I/O, and no other side
 * effects.
 */
export function mergeOptions(
  defaults: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, string>>,
): Record<string, string> {
  return { ...overrides, ...defaults };
}
