import { createAnalytics, type Analytics } from '@campus/analytics';
import { Global, Logger, Module } from '@nestjs/common';

import { CONFIG, type Env } from '../config/config.module.js';

export const ANALYTICS = Symbol('ANALYTICS');

export type { Analytics };

const logger = new Logger('Analytics');

@Global()
@Module({
  providers: [
    {
      provide: ANALYTICS,
      inject: [CONFIG],
      useFactory: (config: Env): Analytics =>
        createAnalytics({
          enabled: config.FF_ANALYTICS_ENABLED,
          token: config.POSTHOG_PROJECT_TOKEN,
          host: config.POSTHOG_HOST,
          environment: config.DEPLOYMENT_ENVIRONMENT,
          release: config.RAILWAY_GIT_COMMIT_SHA,
          onDropped: (event, reason) =>
            logger.warn(`Dropped ${event}: ${reason}`),
        }),
    },
  ],
  exports: [ANALYTICS],
})
export class AnalyticsModule {}
