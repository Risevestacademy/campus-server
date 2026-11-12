import { Module } from '@nestjs/common';

import { SessionModule } from '../auth/session.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { NoticeCommentsController } from './notice-comments.controller.js';
import { NoticeCommentsService } from './notice-comments.service.js';
import { NoticesController } from './notices.controller.js';
import { NoticesService } from './notices.service.js';

@Module({
  imports: [SessionModule, NotificationsModule],
  controllers: [NoticesController, NoticeCommentsController],
  providers: [NoticesService, NoticeCommentsService],
})
export class NoticesModule {}
