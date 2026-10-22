import type { IncomingMessage, ServerResponse } from 'node:http';

import { Global, Module } from '@nestjs/common';
import { reportLoggedError } from '@campus/error-reporting';
import { matchesPath, pathOf } from '@campus/telemetry/paths';
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
import { QUIET_ROUTES } from './quiet-routes.js';

export { CORRELATION_ID_HEADER };

export function isUnloggedRoute(url: string | undefined): boolean {
  return matchesPath(url, QUIET_ROUTES);
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
          hooks: {
            logMethod(args, method, level) {
              reportLoggedError(reporter, level, args, this.bindings());
              method.apply(this, args);
            },
          },
          genReqId: (req: IncomingMessage, res: ServerResponse) => {
            // The one place the id is decided. What is returned here is
            // what the logs, the response header and any audit entry carry.
            const id = resolveCorrelationId(req.headers[CORRELATION_ID_HEADER]);
            res.setHeader(CORRELATION_ID_HEADER, id);
            return id;
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
          // The request is serialized before routing; its route is known
          // only once the response is done.
          customProps: (req, res) =>
            res.writableEnded
              ? { route: (req as { route?: { path?: string } }).route?.path }
              : {},
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
              '*.email',
              '*.idToken',
              '*.refreshToken',
            ],
            censor: '[REDACTED]',
          },
          serializers: {
            req: (req) => ({
              id: req.id,
              method: req.method,
              url: pathOf(req.url),
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
