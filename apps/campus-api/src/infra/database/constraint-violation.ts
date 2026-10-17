/**
 * Whether a failed write was Postgres refusing a row with SQLSTATE `code`,
 * and, when `constraint` is given, on the constraint of that name.
 *
 * The one place the error is taken apart, for isUniqueViolation,
 * isForeignKeyViolation and isCheckViolation. drizzle wraps the driver
 * error, and the drivers disagree on where the name lives (postgres.js:
 * `constraint_name`, PGlite: `constraint`), so both the code and the name
 * are looked for along the same chain, however deep the driver's error sits
 * in it, messages included.
 */
export function isConstraintViolation(
  err: unknown,
  code: string,
  constraint?: string,
): boolean {
  let codeFound = false;
  let nameFound = constraint === undefined;
  for (const link of causeChain(err)) {
    if (link['code'] === code) codeFound = true;
    if (!nameFound) {
      nameFound = ['constraint', 'constraint_name', 'message'].some((key) => {
        const value = link[key];
        return typeof value === 'string' && value.includes(constraint!);
      });
    }
    if (codeFound && nameFound) return true;
  }
  return false;
}

/**
 * The error and every `cause` beneath it, to the end of the chain. Each link
 * is visited once: a chain that loops back on itself stops where it would
 * repeat, rather than running forever. No depth limit, since a limit would
 * leave a driver error past it unread.
 */
function causeChain(err: unknown): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  let current: unknown = err;
  while (
    typeof current === 'object' &&
    current !== null &&
    !seen.has(current)
  ) {
    seen.add(current);
    const link = current as Record<string, unknown>;
    chain.push(link);
    current = link['cause'];
  }
  return chain;
}
