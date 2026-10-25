import { stdSerializers, type SerializedError } from 'pino';

import { scrubError } from './scrub.js';

/**
 * pino's `err` serializer, run on the scrubbed error: log lines leave for
 * Grafana, so a failed query's values stay out of them as they do PostHog.
 * Whatever is logged as `err` but is not an error passes as it is.
 */
export function serializeError(error: Error): SerializedError {
  return error instanceof Error
    ? stdSerializers.err(scrubError(error) as Error)
    : error;
}
