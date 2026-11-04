import { Module } from '@nestjs/common';

import { SessionModule } from '../auth/session.module.js';
import { NoticeCommentsService } from './notice-comments.service.js';
import {
  NoticeCommentsController,
  NoticesController,
} from './notices.controller.js';
import { NoticesService } from './notices.service.js';

@Module({
  imports: [SessionModule],
  controllers: [NoticesController, NoticeCommentsController],
  providers: [NoticesService, NoticeCommentsService],
})
export class NoticesModule {}
