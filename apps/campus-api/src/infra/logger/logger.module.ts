import { context, trace } from '@opentelemetry/api';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { Global, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import {
  CORRELATION_ID_HEADER,
  resolveCorrelationId,
} from '../../shared/http/correlation-id.js';
import { CONFIG, type Env } from '../config/config.module.js';

export { CORRELATION_ID_HEADER };

const UNLOGGED_PATHS = ['/v1/health', '/docs', '/docs-json'];

export function isUnloggedRoute(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0] ?? '';
  return UNLOGGED_PATHS.some(
    (unlogged) => path === unlogged || path.startsWith(`${unlogged}/`),
  );
}

@Global()
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [CONFIG],
      useFactory: (config: Env) => ({
        pinoHttp: {
          level: config.FF_LOG_LEVEL,
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
          autoLogging: {
            ignore: (req: IncomingMessage) => isUnloggedRoute(req.url),
          },
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              '*.password',
              '*.token',
              '*.secret',
            ],
            censor: '[REDACTED]',
          },
          serializers: {
            req: (req) => ({
              id: req.id,
              method: req.method,
              url: req.url,
              remoteAddress: req.remoteAddress,
              remotePort: req.remotePort,
            }),
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
