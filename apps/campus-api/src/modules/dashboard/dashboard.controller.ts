import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { AdminGuard } from '../../shared/auth/admin.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { DashboardService } from './dashboard.service.js';
import { ApiDashboardFigures } from './docs/dashboard.docs.js';
import {
  DashboardFiguresQueryDto,
  type DashboardFiguresDto,
} from './dto/dashboard-figures.dto.js';

@ApiTags('dashboard')
@ApiBearerAuth()
@UseGuards(SessionGuard, AdminGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @ApiDashboardFigures()
  figures(
    @Query() query: DashboardFiguresQueryDto,
  ): Promise<DashboardFiguresDto> {
    return this.dashboard.figures(query.cohortId);
  }
}
