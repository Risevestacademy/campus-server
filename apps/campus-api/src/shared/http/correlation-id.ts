import { randomUUID } from 'node:crypto';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/** The audit log's column width; a UUID fits with room to spare. */
export const CORRELATION_ID_MAX_LENGTH = 64;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The id a request is known by everywhere: the caller's `x-correlation-id`
 * when it is a UUID, a fresh one otherwise.
 *
 * Decided once, as the request arrives, so the log lines, the response header,
 * error reports, analytics and the audit entry all carry the same id. Anything
 * else a caller sends is replaced rather than kept, since free text could hold
 * a name or an email and would reach every one of those.
 */
export function resolveCorrelationId(incoming: unknown): string {
  return typeof incoming === 'string' && UUID.test(incoming)
    ? incoming
    : randomUUID();
}
