import { randomUUID } from 'node:crypto';
import { context, trace } from '@opentelemetry/api';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { Global, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { CONFIG, type Env } from '../config/config.module.js';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

@Global()
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [CONFIG],
      useFactory: (config: Env) => ({
        pinoHttp: {
          level: config.FF_LOG_LEVEL,
          genReqId: (req: IncomingMessage, res: ServerResponse) => {
            const incoming = req.headers[CORRELATION_ID_HEADER];
            const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
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
            ignore: (req: IncomingMessage) => req.url === '/docs' || req.url === '/reference',
          },
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token', '*.secret'],
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