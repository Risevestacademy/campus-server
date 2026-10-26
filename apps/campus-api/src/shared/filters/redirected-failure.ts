import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import type { PinoLogger } from 'nestjs-pino';

import { resolveExceptionStatus } from '../exceptions/index.js';

/**
 * For filters that answer a navigation with a redirect: the global filters
 * never see the exception, so it is logged here. A 5xx is an error; anything
 * else that lands here is a warning. Not the URL: it can carry Google's code.
 */
export function logRedirectedFailure(
  logger: PinoLogger,
  exception: unknown,
  req: Request & { id?: string },
  unexpected: string,
): void {
  const fault =
    resolveExceptionStatus(exception) >= HttpStatus.INTERNAL_SERVER_ERROR;
  logger[fault ? 'error' : 'warn'](
    { err: exception, method: req.method, correlationId: req.id },
    fault ? 'Unhandled exception' : unexpected,
  );
}
