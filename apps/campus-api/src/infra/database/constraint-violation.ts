/**
 * Whether a failed write was Postgres refusing a row with SQLSTATE `code`,
 * and, when `constraint` is given, on the constraint of that name.
 *
 * The one place the error is taken apart, for isUniqueViolation,
 * isForeignKeyViolation and isCheckViolation. drizzle wraps the driver
 * error, and the drivers disagree on where the name lives (postgres.js:
 * `constraint_name`, PGlite: `constraint`), so the whole cause chain is
 * searched, messages included.
 */
export function isConstraintViolation(
  err: unknown,
  code: string,
  constraint?: string,
): boolean {
  const found =
    (err as { code?: unknown } | null)?.code ??
    (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (found !== code) return false;
  if (constraint === undefined) return true;

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
