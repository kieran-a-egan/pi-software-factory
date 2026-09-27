/**
 * autonomy-v1-002 pristine candidate fixture: strict boolean token parser.
 *
 * The exported {@link parseBoolean} initially recognizes exactly the two
 * existing lowercase tokens: it returns `true` for `'true'`, `false` for
 * `'false'`, and `undefined` for every other string. The requested additive
 * feature (the exact lowercase aliases `'yes'` -> true and `'no'` -> false)
 * is intentionally absent from this pristine source. Matching is
 * case-sensitive and performs no trimming. The function is pure: it uses no
 * randomness, no I/O, and no other side effects.
 */
export function parseBoolean(value: string): boolean | undefined {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return undefined;
}
