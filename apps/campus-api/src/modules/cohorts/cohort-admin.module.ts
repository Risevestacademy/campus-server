import { Module } from '@nestjs/common';

import { AdminGuard } from '../../shared/auth/admin.guard.js';
import { SessionModule } from '../auth/session.module.js';
import { CohortRosterService } from './cohort-roster.service.js';
import { CohortsController } from './cohorts.controller.js';
import { CohortsService } from './cohorts.service.js';

/**
 * The admin routes for cohorts, apart from CohortsModule on purpose.
 * SessionModule imports CohortsModule to check memberships at sign-in, and
 * these routes need SessionModule's guards — in one module that would be a
 * cycle.
 */
@Module({
  imports: [SessionModule],
  controllers: [CohortsController],
  providers: [CohortsService, CohortRosterService, AdminGuard],
})
export class CohortAdminModule {}
