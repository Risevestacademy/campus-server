import { Module } from '@nestjs/common';

import { SessionModule } from '../../auth/session.module.js';
import { CohortProfilesController } from './cohort-profiles.controller.js';
import { ProfileController } from './profile.controller.js';
import { ProfileService } from './profile.service.js';

/**
 * The profile routes, apart from UsersModule for the reason UserAdminModule
 * is: SessionModule imports UsersModule, and these routes need
 * SessionModule's guard.
 */
@Module({
  imports: [SessionModule],
  controllers: [ProfileController, CohortProfilesController],
  providers: [ProfileService],
})
export class ProfileModule {}
