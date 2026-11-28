import { Module } from '@nestjs/common';

import { AdminGuard } from '../../shared/auth/admin.guard.js';
import { SessionModule } from '../auth/session.module.js';
import { MediaModule } from '../media/media.module.js';
import { FeedbackNotifier } from './feedback-notifier.js';
import { FeedbackController } from './feedback.controller.js';
import { FeedbackService } from './feedback.service.js';

@Module({
  imports: [SessionModule, MediaModule],
  controllers: [FeedbackController],
  providers: [FeedbackService, FeedbackNotifier, AdminGuard],
})
export class FeedbackModule {}
