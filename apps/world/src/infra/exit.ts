interface Flushable {
  shutdown(): Promise<void>;
}

/**
 * Sends what PostHog and telemetry still hold, together. A flush that fails
 * is a warning, never a throw: it runs last, on the way out, and must not
 * stop the exit that follows.
 */
export async function flushAll(
  log: { warn(fields: object, message: string): void },
  flushables: readonly (Flushable | undefined)[],
): Promise<void> {
  const results = await Promise.allSettled(
    flushables.map((flushable) => flushable?.shutdown()),
  );
  for (const result of results) {
    if (result.status === 'rejected') {
      log.warn({ err: result.reason }, 'could not flush on exit');
    }
  }
}
