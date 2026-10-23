import { context, trace } from '@opentelemetry/api';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { Global, Module } from '@nestjs/common';
import { LOG_REDACT_PATHS, reportingHooks } from '@campus/error-reporting';
import { LoggerModule } from 'nestjs-pino';

import {
  CORRELATION_ID_HEADER,
  resolveCorrelationId,
} from '../../shared/http/correlation-id.js';
import { CONFIG, type Env } from '../config/config.module.js';
import {
  ERROR_REPORTER,
  ErrorReportingModule,
  type ErrorReporter,
} from '../error-reporting/error-reporting.module.js';

export { CORRELATION_ID_HEADER };

const UNLOGGED_PATHS = ['/v1/health', '/docs', '/docs-json'];

/** Query strings stay out of the logs: the Google callback's carries the OAuth code. */
export function pathOf(url: string | undefined): string {
  return (url ?? '').split('?')[0] ?? '';
}

/** A request as the request log shows it: the path, never the query string. */
export function serializeRequest(req: {
  id?: unknown;
  method?: string;
  url?: string;
  remoteAddress?: string;
  remotePort?: number;
}) {
  return {
    id: req.id,
    method: req.method,
    url: pathOf(req.url),
    remoteAddress: req.remoteAddress,
    remotePort: req.remotePort,
  };
}

/**
 * The route a finished request matched. The request is serialized before
 * routing, so the route is added only once the response is done.
 */
export function routeOnceFinished(
  req: object,
  res: { writableEnded: boolean },
): { route?: string } {
  return res.writableEnded
    ? { route: (req as { route?: { path?: string } }).route?.path }
    : {};
}

export function isUnloggedRoute(url: string | undefined): boolean {
  const path = pathOf(url);
  return UNLOGGED_PATHS.some(
    (unlogged) => path === unlogged || path.startsWith(`${unlogged}/`),
  );
}

@Global()
@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [ErrorReportingModule],
      inject: [CONFIG, ERROR_REPORTER],
      useFactory: (config: Env, reporter: ErrorReporter) => ({
        pinoHttp: {
          level: config.FF_LOG_LEVEL,
          hooks: reportingHooks(reporter),
          genReqId: (req: IncomingMessage, res: ServerResponse) => {
            // The one place the id is decided. What is returned here is
            // what the logs, the response header and any audit entry carry.
            const id = resolveCorrelationId(req.headers[CORRELATION_ID_HEADER]);
            res.setHeader(CORRELATION_ID_HEADER, id);
            return id;
          },
          mixin: () => {
            const span = trace.getSpan(context.active());
            const traceId = span?.spanContext().traceId;
            const spanId = span?.spanContext().spanId;
            if (!traceId || !spanId) return {};
            return { trace_id: traceId, span_id: spanId };
          },
          transport: config.FF_LOG_PRETTY
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
          customProps: (req, res) => routeOnceFinished(req, res),
          autoLogging: {
            ignore: (req: IncomingMessage) => isUnloggedRoute(req.url),
          },
          redact: {
            paths: [...LOG_REDACT_PATHS],
            censor: '[REDACTED]',
          },
          serializers: {
            req: serializeRequest,
            res: (res) => ({
              statusCode: res.statusCode,
            }),
          },
        },
      }),
    }),
  ],
  exports: [LoggerModule],
})
export class AppLoggerModule {}
