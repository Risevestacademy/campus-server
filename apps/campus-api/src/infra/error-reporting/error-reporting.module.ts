import { Global, Module } from '@nestjs/common';
import {
  createErrorReporter,
  type ErrorReporter,
} from '@campus/error-reporting';

import { CONFIG, type Env } from '../config/config.module.js';

export const ERROR_REPORTER = Symbol('ERROR_REPORTER');

export type { ErrorReporter };

@Global()
@Module({
  providers: [
    {
      provide: ERROR_REPORTER,
      inject: [CONFIG],
      useFactory: (config: Env): ErrorReporter =>
        createErrorReporter({
          enabled: config.FF_POSTHOG_ENABLED,
          token: config.POSTHOG_PROJECT_TOKEN,
          host: config.POSTHOG_HOST,
          service: config.OTEL_SERVICE_NAME,
          environment: config.DEPLOYMENT_ENVIRONMENT,
          release: config.RAILWAY_GIT_COMMIT_SHA,
        }),
    },
  ],
  exports: [ERROR_REPORTER],
})
export class ErrorReportingModule {}
