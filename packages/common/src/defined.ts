/**
 * `value` without its undefined members, so an optional field is left out
 * rather than present as `undefined` (wire objects under
 * `exactOptionalPropertyTypes`, log fields).
 */
export function withoutUndefined<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };
}
