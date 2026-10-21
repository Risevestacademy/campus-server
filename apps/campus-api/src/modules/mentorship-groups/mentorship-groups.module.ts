import { Module } from '@nestjs/common';

import { AdminGuard } from '../../shared/auth/admin.guard.js';
import { SessionModule } from '../auth/session.module.js';
import { MentorshipGroupsController } from './mentorship-groups.controller.js';
import { MentorshipGroupsService } from './mentorship-groups.service.js';

@Module({
  imports: [SessionModule],
  controllers: [MentorshipGroupsController],
  providers: [MentorshipGroupsService, AdminGuard],
})
export class MentorshipGroupsModule {}
