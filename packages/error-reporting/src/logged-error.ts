import { trace } from '@opentelemetry/api';

import type { ErrorReporter } from './error-reporter.js';

const PINO_ERROR = 50;
const PINO_FATAL = 60;

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
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
  bindings: Fields = {},
): void {
  if (level < PINO_ERROR) {
    return;
  }

  const [first, second] = args;
  const fields = isFields(first) && !(first instanceof Error) ? first : {};
  const error = first instanceof Error ? first : fields.err;
  if (error === undefined) {
    return;
  }

  const boundRequest = isFields(bindings.req) ? bindings.req : {};
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
      log_context: text(fields.context),
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
