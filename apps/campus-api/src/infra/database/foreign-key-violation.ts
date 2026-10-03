/**
 * Whether a failed write was Postgres refusing a foreign key on `constraint`.
 *
 * The mirror of isUniqueViolation, and for the same reason: a DELETE that the
 * database's restrictive FKs block is a 409 the caller can act on, not a 500.
 * SQLSTATE 23503 with no constraint checks only the class — a delete is
 * stopped by whichever link is present, and the caller does not need to know
 * which.
 */
export function isForeignKeyViolation(
  err: unknown,
  constraint?: string,
): boolean {
  const code =
    (err as { code?: unknown } | null)?.code ??
    (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (code !== '23503') return false;
  if (!constraint) return true;

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
