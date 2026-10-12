/**
 * Whether a failed write was Postgres refusing a row on the CHECK named
 * `constraint`.
 *
 * The third of its kind, beside isUniqueViolation and isForeignKeyViolation,
 * and for the same reason: a row the database will not take because of what
 * the caller sent is theirs to correct, a 400, and not a 500. SQLSTATE 23514
 * plus the constraint's name, searched for down the cause chain because
 * drizzle wraps the driver error and the drivers disagree on where the name
 * lives.
 */
export function isCheckViolation(err: unknown, constraint: string): boolean {
  const code =
    (err as { code?: unknown } | null)?.code ??
    (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (code !== '23514') return false;

  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth++) {
    if (typeof current !== 'object') break;
    const record = current as Record<string, unknown>;
    for (const key of ['constraint', 'constraint_name', 'message']) {
      const value = record[key];
      if (typeof value === 'string' && value.includes(constraint)) {
        return true;
      }
    }
    current = record['cause'];
  }
  return false;
}
