import { stdSerializers, type SerializedError } from 'pino';

import { scrubError } from './scrub.js';

/**
 * pino's `err` serializer, run on the scrubbed error: log lines leave for
 * Grafana, so a failed query's values stay out of them as they do PostHog.
 * pino-http wraps it around its own, so it can be handed pino's serialized
 * error, which keeps the original as `raw`. Anything else passes as it is.
 */
export function serializeError(input: unknown): SerializedError {
  const raw = (input as { raw?: unknown } | null | undefined)?.raw;
  const error = raw instanceof Error ? raw : input;
  return error instanceof Error
    ? stdSerializers.err(scrubError(error))
    : (input as SerializedError);
}
