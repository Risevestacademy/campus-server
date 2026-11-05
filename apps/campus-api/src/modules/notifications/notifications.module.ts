import { Module } from '@nestjs/common';

import { CONFIG } from '../../infra/config/config.constants.js';
import type { Env } from '../../infra/config/env.js';
import { SessionModule } from '../auth/session.module.js';
import {
  NOTIFICATION_PUBLISHER,
  connectNotificationPublisher,
  disabledNotificationPublisher,
} from './notification-publisher.js';
import { NotificationPush } from './notification-push.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  imports: [SessionModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationPush,
    {
      provide: NOTIFICATION_PUBLISHER,
      inject: [CONFIG],
      useFactory: (config: Env) =>
        config.REDIS_URL
          ? connectNotificationPublisher(config.REDIS_URL)
          : disabledNotificationPublisher,
    },
  ],
  exports: [NotificationsService, NotificationPush],
})
export class NotificationsModule {}
