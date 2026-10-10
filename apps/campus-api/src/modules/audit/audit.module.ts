import { Module } from '@nestjs/common';

import { AdminGuard } from '../../shared/auth/admin.guard.js';
import { SessionModule } from '../auth/session.module.js';
import { AuditLogController } from './audit-log.controller.js';
import { AuditLogService } from './audit-log.service.js';

/** The admin read route. Writing needs no module: writeAuditEntry is a function. */
@Module({
  imports: [SessionModule],
  controllers: [AuditLogController],
  providers: [AuditLogService, AdminGuard],
})
export class AuditModule {}
