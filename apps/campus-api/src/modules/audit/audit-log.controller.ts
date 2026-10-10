import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { AdminGuard } from '../../shared/auth/admin.guard.js';
import type { PaginatedResponseDto } from '../../shared/dto/index.js';
import { SessionGuard } from '../auth/session.guard.js';
import { AuditLogService } from './audit-log.service.js';
import { ApiListAuditLog } from './docs/audit-log.docs.js';
import {
  ListAuditLogQueryDto,
  type AuditLogEntryDto,
} from './dto/list-audit-log.dto.js';

@ApiTags('audit-log')
@ApiBearerAuth()
@UseGuards(SessionGuard, AdminGuard)
@Controller('audit-log')
export class AuditLogController {
  constructor(private readonly auditLog: AuditLogService) {}

  @Get()
  @ApiListAuditLog()
  list(
    @Query() query: ListAuditLogQueryDto,
  ): Promise<PaginatedResponseDto<AuditLogEntryDto>> {
    return this.auditLog.list(query);
  }
}
