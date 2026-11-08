import { Module } from '@nestjs/common';

import { SessionModule } from '../auth/session.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { NoticesController } from './notices.controller.js';
import { NoticesService } from './notices.service.js';

@Module({
  imports: [SessionModule, NotificationsModule],
  controllers: [NoticesController],
  providers: [NoticesService],
})
export class NoticesModule {}
