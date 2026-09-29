/**
 * autonomy-v1-010 pristine candidate fixture: generic windowed chunking.
 *
 * The exported {@link chunk} intentionally carries the final-partial-chunk
 * omission defect that is the subject of this benchmark case: it emits a
 * fresh chunk for every complete window only and silently drops the
 * trailing incomplete window. For example `chunk([1, 2, 3, 4, 5], 2)`
 * returns `[[1, 2], [3, 4]]` instead of `[[1, 2], [3, 4], [5]]`. The
 * remaining pristine behavior is already correct: complete chunks are
 * emitted in order, retained elements preserve their identity and original
 * order, the returned outer array and every inner chunk are fresh arrays
 * distinct from the input and from each other, the supplied array is never
 * mutated, and an input whose length is a multiple of `size` yields no extra
 * empty chunk. The function is pure: it uses no randomness, no I/O, and no
 * other side effects.
 */
export function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start + size <= values.length; start += size) {
    chunks.push(values.slice(start, start + size));
  }
  return chunks;
}
