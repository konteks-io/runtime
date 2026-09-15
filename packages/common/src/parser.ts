/**
 * The structural shape every request helper accepts for its response schema.
 *
 * Deliberately not `z.ZodType<T>`: inferring `T` through zod's generic from
 * the piped public-object contract schemas costs the checker about a minute
 * per call site, while inferring it from `parse`'s return type is immediate.
 */
export interface SchemaParser<T> {
  parse(value: unknown): T;
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: readonly unknown[] } };
}
