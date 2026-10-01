/**
 * Whether a failed write was Postgres refusing a duplicate on `constraint`.
 *
 * Checked by SQLSTATE (23505, unique_violation) plus the constraint's name,
 * so a duplicate on one key is never mistaken for one on another. drizzle
 * wraps the driver error, and the drivers disagree on where the name lives
 * (postgres.js: `constraint_name`, PGlite: `constraint`), so the whole cause
 * chain is searched, messages included.
 */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  const code =
    (err as { code?: unknown } | null)?.code ??
    (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (code !== '23505') return false;

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
