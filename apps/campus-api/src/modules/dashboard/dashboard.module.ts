import { Module } from '@nestjs/common';

import { AdminGuard } from '../../shared/auth/admin.guard.js';
import { SessionModule } from '../auth/session.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

@Module({
  imports: [SessionModule],
  controllers: [DashboardController],
  providers: [DashboardService, AdminGuard],
})
export class DashboardModule {}
