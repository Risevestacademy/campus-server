import type { LoggedErrorFields } from '@campus/error-reporting';

import type { AuthenticatedRequest } from '../auth/authenticated-user.js';

export type LoggedRequest = AuthenticatedRequest & { id?: string };

/**
 * What an error log line says about its request: the route as declared and
 * the path without its query string, which can carry tokens and codes.
 */
export function requestFields(
  request: LoggedRequest | undefined,
  statusCode: number,
): Omit<LoggedErrorFields, 'err' | 'severity'> & { path?: string } {
  return {
    method: request?.method,
    path: request?.path,
    route: (request?.route as { path?: string } | undefined)?.path,
    statusCode,
    correlationId: request?.id,
    userId: request?.user?.id,
  };
}
