import { isConstraintViolation } from './constraint-violation.js';

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
  return isConstraintViolation(err, '23503', constraint);
}
