import { randomUUID } from 'node:crypto';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * The longest correlation id a request may bring. The audit log's column is
 * this wide, and that is the reason for the number: an id is only useful if
 * the log line, the response header and the audit entry all carry the same
 * one.
 */
export const CORRELATION_ID_MAX_LENGTH = 64;

/**
 * The id a request is known by everywhere: the caller's `x-correlation-id`
 * when it sent a usable one, a fresh id otherwise.
 *
 * Decided once, as the request arrives, so nothing downstream has to trim or
 * second-guess it. An id that is empty or too long is replaced outright
 * rather than cut: a shortened id would match the caller's in no system,
 * while a new one is at least returned to them in the response header.
 */
export function resolveCorrelationId(incoming: unknown): string {
  return typeof incoming === 'string' &&
    incoming.length > 0 &&
    incoming.length <= CORRELATION_ID_MAX_LENGTH
    ? incoming
    : randomUUID();
}
