import { Module } from '@nestjs/common';

import { AdminGuard } from '../../shared/auth/admin.guard.js';
import { SessionModule } from '../auth/session.module.js';
import { UserDirectoryService } from './user-directory.service.js';
import { UsersController } from './users.controller.js';

/**
 * The admin routes for users, apart from UsersModule on purpose, as
 * CohortAdminModule is from CohortsModule: SessionModule imports UsersModule
 * to read the account behind a session, and these routes need SessionModule's
 * guards — in one module that would be a cycle.
 */
@Module({
  imports: [SessionModule],
  controllers: [UsersController],
  providers: [UserDirectoryService, AdminGuard],
})
export class UserAdminModule {}
