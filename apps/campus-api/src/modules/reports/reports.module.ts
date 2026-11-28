import { Module } from '@nestjs/common';

import { AdminGuard } from '../../shared/auth/admin.guard.js';
import { SessionModule } from '../auth/session.module.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

@Module({
  imports: [SessionModule],
  controllers: [ReportsController],
  providers: [ReportsService, AdminGuard],
})
export class ReportsModule {}
