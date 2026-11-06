import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import { SuperAdminGuard } from '../../shared/auth/super-admin.guard.js';
import { CorrelationId } from '../../shared/http/correlation-id.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiSweepRetention } from './docs/retention.docs.js';
import {
  SweepRetentionDto,
  type SweepRetentionResponseDto,
} from './dto/sweep-retention.dto.js';
import { RetentionService } from './retention.service.js';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(SessionGuard, SuperAdminGuard)
@Controller('admin/retention')
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Post('sweep')
  @HttpCode(HttpStatus.OK)
  @ApiSweepRetention()
  async sweep(
    @Body() dto: SweepRetentionDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<SweepRetentionResponseDto> {
    return {
      swept: await this.retention.sweep({
        table: dto.table,
        retentionDays: dto.retentionDays,
        actorUserId: admin.id,
        correlationId,
      }),
    };
  }
}
