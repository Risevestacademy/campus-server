import {
  LOG_REDACT_PATHS,
  reportingHooks,
  type ErrorReporter,
} from '@campus/error-reporting';
import { pathOf } from '@campus/telemetry/paths';
import type { FastifyServerOptions } from 'fastify';
import { randomUUID } from 'node:crypto';

import type { Env } from './env.js';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/** A request as the request log shows it: the path, never the query string. */
export function serializeRequest(req: {
  id: string;
  method: string;
  url: string;
  routeOptions?: { url?: string };
}) {
  return {
    id: req.id,
    method: req.method,
    url: pathOf(req.url),
    route: req.routeOptions?.url,
  };
}

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
    hooks: reportingHooks(reporter),
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
      paths: [...LOG_REDACT_PATHS],
      censor: '[REDACTED]',
    },
    serializers: {
      req: serializeRequest,
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
