import { reportLoggedError, type ErrorReporter } from '@campus/error-reporting';
import { pathOf } from '@campus/telemetry/paths';
import type { FastifyServerOptions } from 'fastify';
import { randomUUID } from 'node:crypto';

import type { Env } from './env.js';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Same shape as campus-api's logging: one correlation id per request, echoed
 * back, so a trail through the API and a trail through here can be joined.
 */
export function loggerOptions(
  env: Env,
  reporter: ErrorReporter,
): FastifyServerOptions['logger'] {
  return {
    level: env.FF_LOG_LEVEL,
    hooks: {
      logMethod(args, method, level) {
        reportLoggedError(reporter, level, args, this.bindings());
        method.apply(this, args);
      },
    },
    transport: env.FF_LOG_PRETTY
      ? {
          target: 'pino-pretty',
          options: {
            singleLine: true,
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.token',
        '*.secret',
        '*.email',
      ],
      censor: '[REDACTED]',
    },
    serializers: {
      // The path alone: a query string can carry anything a client puts in it.
      req: (req: {
        id: string;
        method: string;
        url: string;
        routeOptions?: { url?: string };
      }) => ({
        id: req.id,
        method: req.method,
        url: pathOf(req.url),
        route: req.routeOptions?.url,
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  };
}

export function correlationId(headers: Record<string, unknown>): string {
  const incoming = headers[CORRELATION_ID_HEADER];
  return typeof incoming === 'string' && incoming.length > 0
    ? incoming.slice(0, 200)
    : randomUUID();
}
