import type { FastifyServerOptions } from 'fastify';
import { randomUUID } from 'node:crypto';

import type { Env } from './env.js';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Same shape as campus-api's logging: one correlation id per request, echoed
 * back, so a trail through the API and a trail through here can be joined.
 */
export function loggerOptions(env: Env): FastifyServerOptions['logger'] {
  return {
    level: env.FF_LOG_LEVEL,
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
      ],
      censor: '[REDACTED]',
    },
    serializers: {
      req: (req: { id: string; method: string; url: string }) => ({
        id: req.id,
        method: req.method,
        url: req.url,
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
