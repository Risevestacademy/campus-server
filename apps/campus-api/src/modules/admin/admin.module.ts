import { Module } from '@nestjs/common';

import { SuperAdminGuard } from '../../shared/auth/super-admin.guard.js';
import { SessionModule } from '../auth/session.module.js';
import { RetentionController } from './retention.controller.js';
import { RetentionService } from './retention.service.js';

/** Operations that reach across modules' tables, for super admins only. */
@Module({
  imports: [SessionModule],
  controllers: [RetentionController],
  providers: [RetentionService, SuperAdminGuard],
})
export class AdminModule {}
