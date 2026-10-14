import { isConstraintViolation } from './constraint-violation.js';

/**
 * Whether a failed write was Postgres refusing a duplicate on `constraint`.
 *
 * Checked by SQLSTATE (23505, unique_violation) plus the constraint's name,
 * so a duplicate on one key is never mistaken for one on another.
 */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  return isConstraintViolation(err, '23505', constraint);
}
