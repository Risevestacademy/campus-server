import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { AdminGuard } from '../../shared/auth/admin.guard.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import { CorrelationId } from '../../shared/http/correlation-id.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import {
  ApiAttendanceReport,
  ApiMembershipReport,
} from './docs/reports.docs.js';
import {
  AttendanceReportQueryDto,
  MembershipReportQueryDto,
  ReportCohortParamDto,
  ReportFormat,
  type AttendanceReportDto,
  type MembershipReportDto,
} from './dto/reports.dto.js';
import { ReportsService, type CsvReport } from './reports.service.js';

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(SessionGuard, AdminGuard)
@Controller('cohorts/:cohortId/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('membership')
  @ApiMembershipReport()
  async membership(
    @Param() params: ReportCohortParamDto,
    @Query() { format, ...query }: MembershipReportQueryDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MembershipReportDto | string> {
    if (format === ReportFormat.Csv) {
      return send(
        res,
        await this.reports.membershipCsv(params.cohortId, query, {
          actorUserId: admin.id,
          correlationId,
        }),
      );
    }
    noStore(res);
    return this.reports.membership(params.cohortId, query);
  }

  @Get('attendance')
  @ApiAttendanceReport()
  async attendance(
    @Param() params: ReportCohortParamDto,
    @Query() { format, ...query }: AttendanceReportQueryDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AttendanceReportDto | string> {
    if (format === ReportFormat.Csv) {
      return send(
        res,
        await this.reports.attendanceCsv(params.cohortId, query, {
          actorUserId: admin.id,
          correlationId,
        }),
      );
    }
    noStore(res);
    return this.reports.attendance(params.cohortId, query);
  }
}

/** Personal data: no cache along the way keeps a copy. */
function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

function send(res: Response, report: CsvReport): string {
  noStore(res);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${report.filename}"`,
  );
  return report.body;
}
