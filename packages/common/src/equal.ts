/**
 * Whether every pair holds the same value on both sides (`===`). For exact
 * ownership checks that compare many fields of a request against the state
 * that must own it.
 */
export function allEqual(pairs: ReadonlyArray<readonly [unknown, unknown]>): boolean {
  return pairs.every(([left, right]) => left === right);
}
