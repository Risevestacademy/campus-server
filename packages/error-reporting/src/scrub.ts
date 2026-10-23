const MAX_CAUSE_DEPTH = 4;

interface QueryError extends Error {
  /** drizzle's DrizzleQueryError: the statement, and the values it was given. */
  query?: unknown;
  params?: unknown;
  /** postgres.js's PostgresError: the SQLSTATE. */
  code?: unknown;
  severity?: unknown;
}

function isDrizzleQueryError(error: QueryError): boolean {
  return typeof error.query === 'string' && 'params' in error;
}

function isPostgresError(error: QueryError): boolean {
  return (
    typeof error.code === 'string' &&
    (error.name === 'PostgresError' || 'severity' in error)
  );
}

function framesOf(stack: string | undefined): string {
  return (stack ?? '')
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .join('\n');
}

/**
 * The error as it may leave for PostHog. A failed query's message carries
 * the values it was given: drizzle appends them as `params:`, and Postgres
 * quotes the one it rejected (`invalid input syntax for type uuid: "…"`).
 * Those keep only the statement and the SQLSTATE; everything else, and the
 * stack's frames, pass as they are. Causes are scrubbed the same way.
 */
export function scrubError(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error) || depth > MAX_CAUSE_DEPTH) {
    return error;
  }
  const failed = error as QueryError;
  const message = isDrizzleQueryError(failed)
    ? `Failed query: ${String(failed.query)}`
    : isPostgresError(failed)
      ? `SQLSTATE ${String(failed.code)}`
      : undefined;
  const cause = scrubError(failed.cause, depth + 1);
  if (message === undefined && cause === failed.cause) {
    return error;
  }

  const clean = new Error(
    message ?? error.message,
    cause === undefined ? undefined : { cause },
  );
  clean.name = error.name;
  clean.stack = `${error.name}: ${clean.message}\n${framesOf(error.stack)}`;
  return clean;
}

interface ExceptionEntry {
  type?: unknown;
  value?: unknown;
}

/**
 * The same rule for an exception PostHog captured on its own, uncaught,
 * which never passed through `scrubError`: only its type and message are
 * left to go on.
 */
export function scrubExceptionList(list: unknown): unknown {
  if (!Array.isArray(list)) {
    return list;
  }
  return list.map((entry: ExceptionEntry) => {
    if (typeof entry?.value !== 'string') {
      return entry;
    }
    if (entry.value.startsWith('Failed query:')) {
      return { ...entry, value: entry.value.split('\nparams:')[0] };
    }
    if (entry.type === 'PostgresError') {
      return { ...entry, value: 'PostgresError' };
    }
    return entry;
  });
}
