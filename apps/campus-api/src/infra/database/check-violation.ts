import { isConstraintViolation } from './constraint-violation.js';

/**
 * Whether a failed write was Postgres refusing a row on the CHECK named
 * `constraint`.
 *
 * For the same reason as isUniqueViolation: a row the database will not take
 * because of what the caller sent is theirs to correct, a 400, and not a 500.
 * SQLSTATE 23514 plus the constraint's name.
 */
export function isCheckViolation(err: unknown, constraint: string): boolean {
  return isConstraintViolation(err, '23514', constraint);
}
