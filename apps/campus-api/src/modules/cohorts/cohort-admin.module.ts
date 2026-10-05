import { Module } from '@nestjs/common';

import { AdminGuard } from '../../shared/auth/admin.guard.js';
import { SessionModule } from '../auth/session.module.js';
import { CohortsController } from './cohorts.controller.js';
import { CohortsModule } from './cohorts.module.js';
import { CohortsService } from './cohorts.service.js';

/**
 * The admin routes for cohorts, apart from CohortsModule on purpose.
 * SessionModule imports CohortsModule to check memberships at sign-in, and
 * these routes need SessionModule's guards — in one module that would be a
 * cycle. CohortsModule travels directly as well, for the membership service
 * behind the guest-visit route; it imports nothing, so it closes no loop.
 */
@Module({
  imports: [SessionModule, CohortsModule],
  controllers: [CohortsController],
  providers: [CohortsService, AdminGuard],
})
export class CohortAdminModule {}
