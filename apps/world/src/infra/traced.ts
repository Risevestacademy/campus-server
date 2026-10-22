import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';

const tracer = trace.getTracer('world');

const PINO_ERROR = 50;

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
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Adds to whichever span is running, if any. */
export function annotate(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}

/**
 * Marks the running span failed when an `error` or `fatal` line carrying an
 * error is logged inside it. Most failures are caught, logged and survived,
 * so the log line is the one place that knows; `args` is what pino hands a
 * `logMethod` hook.
 */
export function failActiveSpan(level: number, args: readonly unknown[]): void {
  if (level < PINO_ERROR) {
    return;
  }
  const span = trace.getActiveSpan();
  if (!span) {
    return;
  }
  const [first] = args;
  const error =
    first instanceof Error
      ? first
      : typeof first === 'object' && first !== null
        ? (first as { err?: unknown }).err
        : undefined;
  if (error === undefined) {
    return;
  }
  span.recordException(
    error instanceof Error ? error : new Error(String(error)),
  );
  span.setStatus({ code: SpanStatusCode.ERROR });
}
