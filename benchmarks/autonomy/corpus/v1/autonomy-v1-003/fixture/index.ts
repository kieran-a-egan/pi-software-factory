/**
 * autonomy-v1-003 pristine candidate fixture: strict TCP/UDP port parser.
 *
 * The exported {@link parsePort} parses a strict, untrimmed, non-negative
 * base-10 port number: it returns the value for any string consisting
 * exclusively of digits (no sign, no whitespace, no decimal point, no
 * exponent) whose value is at most 65535, and `undefined` for every other
 * string. The boundary-bug is intentionally present in this pristine source:
 * `parsePort("0")` returns `0` instead of `undefined`. The function is pure:
 * it uses no randomness, no I/O, and no other side effects.
 */
export function parsePort(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) {
    return undefined;
  }
  const port = Number(value);
  if (port > 65535) {
    return undefined;
  }
  return port;
}
