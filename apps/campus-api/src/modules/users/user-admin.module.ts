import { Module } from '@nestjs/common';

import { AdminGuard } from '../../shared/auth/admin.guard.js';
import { fetchWithTimeout } from '../../shared/http/fetch-with-timeout.js';
import { SessionModule } from '../auth/session.module.js';
import { MediaModule } from '../media/media.module.js';
import { AccountDeletionService } from './account-deletion.service.js';
import {
  ANALYTICS_ERASURE_FETCH,
  AnalyticsErasureService,
} from './analytics-erasure.service.js';
import { UserDirectoryService } from './user-directory.service.js';
import { UserRolesService } from './user-roles.service.js';
import { UserStatusService } from './user-status.service.js';
import { UsersController } from './users.controller.js';

/**
 * The admin routes for users, apart from UsersModule on purpose, as
 * CohortAdminModule is from CohortsModule: SessionModule imports UsersModule
 * to read the account behind a session, and these routes need SessionModule's
 * guards — in one module that would be a cycle.
 */
@Module({
  imports: [SessionModule, MediaModule],
  controllers: [UsersController],
  providers: [
    UserDirectoryService,
    UserRolesService,
    UserStatusService,
    AccountDeletionService,
    AnalyticsErasureService,
    { provide: ANALYTICS_ERASURE_FETCH, useValue: fetchWithTimeout },
    AdminGuard,
  ],
})
export class UserAdminModule {}
