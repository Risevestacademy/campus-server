import { loggedError, scrubError } from '@campus/error-reporting';
import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';

const tracer = trace.getTracer('world');

/** Scrubbed, as a log line is: spans leave for Grafana too. */
function asError(value: unknown): Error {
  return value instanceof Error ? scrubError(value) : new Error(String(value));
}

/**
 * Runs `work` in a span of its own, ended when it settles. `root` starts a
 * trace of its own rather than joining whatever is running. A no-op span
 * without a running SDK.
 */
export async function traced<T>(
  name: string,
  work: () => Promise<T>,
  {
    attributes,
    root = false,
  }: { attributes?: Attributes; root?: boolean } = {},
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes, root }, async (span) => {
    try {
      return await work();
    } catch (err) {
      span.recordException(asError(err));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Adds to whichever span is running, if any, leaving out what is unknown. */
export function annotate(
  attributes: Record<string, string | number | boolean | undefined>,
): void {
  const known = Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined),
  ) as Attributes;
  trace.getActiveSpan()?.setAttributes(known);
}

/**
 * Marks the running span failed when an `error` or `fatal` line carrying an
 * error is logged inside it. Most failures are caught, logged and survived,
 * so the log line is the one place that knows; `args` is what pino hands a
 * `logMethod` hook.
 */
export function failActiveSpan(level: number, args: readonly unknown[]): void {
  const span = trace.getActiveSpan();
  const error = loggedError(level, args);
  if (!span || error === undefined) {
    return;
  }
  span.recordException(asError(error));
  span.setStatus({ code: SpanStatusCode.ERROR });
}
