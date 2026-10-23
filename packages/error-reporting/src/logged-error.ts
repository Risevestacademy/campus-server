import { trace } from '@opentelemetry/api';

import type { ErrorReporter } from './error-reporter.js';

const PINO_ERROR = 50;
const PINO_FATAL = 60;

/**
 * The fields of an error log line that are reported, by these names. A
 * logger that wants them reported writes them under exactly these keys.
 */
export interface LoggedErrorFields {
  err?: unknown;
  /** The `users.id` of the person it happened to. */
  userId?: string;
  correlationId?: string;
  method?: string;
  route?: string;
  statusCode?: number;
  /** Reported as a warning rather than an error. */
  severity?: 'warning';
}

/** A log line's first argument, read only through the names above. */
type LineFields = { [K in keyof LoggedErrorFields]?: unknown };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * The error an `error` or `fatal` log line carries: the line's first
 * argument when that is an Error, otherwise its `err`. Undefined for any
 * other line.
 */
export function loggedError(level: number, args: readonly unknown[]): unknown {
  if (level < PINO_ERROR) {
    return undefined;
  }
  const [first] = args;
  if (first instanceof Error) {
    return first;
  }
  return isObject(first) ? first.err : undefined;
}

/**
 * Reports an `error` or `fatal` log line that carries an error. Only named
 * fields go on: the rest of a log line can hold personal data.
 *
 * `args` and `bindings` are what pino hands a `logMethod` hook.
 */
export function reportLoggedError(
  reporter: ErrorReporter,
  level: number,
  args: readonly unknown[],
  bindings: Record<string, unknown> = {},
): void {
  const error = loggedError(level, args);
  if (error === undefined) {
    return;
  }

  const [first, second] = args;
  const fields: LineFields =
    isObject(first) && !(first instanceof Error) ? first : {};

  const boundRequest = isObject(bindings.req) ? bindings.req : {};
  const traceId = trace.getActiveSpan()?.spanContext().traceId;

  reporter.report(error, {
    distinctId: text(fields.userId),
    level:
      level >= PINO_FATAL
        ? 'fatal'
        : fields.severity === 'warning'
          ? 'warning'
          : 'error',
    properties: {
      log_message: text(second),
      correlation_id:
        text(fields.correlationId) ??
        text(bindings.reqId) ??
        text(boundRequest.id),
      method: text(fields.method),
      route: text(fields.route),
      status_code: count(fields.statusCode),
      trace_id: traceId,
    },
  });
}

/**
 * pino `hooks` that report error lines, for campus-api and world alike.
 * `alsoOnError` runs for the same lines, for anything else a service does
 * with them. The level is checked before the logger's bindings are built,
 * so other lines cost nothing.
 */
export function reportingHooks(
  reporter: ErrorReporter,
  alsoOnError?: (level: number, args: readonly unknown[]) => void,
) {
  return {
    logMethod(
      this: { bindings(): Record<string, unknown> },
      args: unknown[],
      method: { apply(thisArg: unknown, args: unknown[]): unknown },
      level: number,
    ): void {
      if (level >= PINO_ERROR) {
        reportLoggedError(reporter, level, args, this.bindings());
        alsoOnError?.(level, args);
      }
      method.apply(this, args);
    },
  };
}
