import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { AdminGuard } from '../../shared/auth/admin.guard.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import {
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../../shared/dto/index.js';
import { CorrelationId } from '../../shared/http/correlation-id.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { CohortsService } from './cohorts.service.js';
import {
  ApiAttachTrack,
  ApiCreateCohort,
  ApiGetCohort,
  ApiListCohorts,
} from './docs/cohorts.docs.js';
import { AttachTrackDto, CohortIdParamDto } from './dto/attach-track.dto.js';
import {
  CohortDetailResponseDto,
  CohortResponseDto,
  CohortTrackResponseDto,
} from './dto/cohort-response.dto.js';
import { CreateCohortDto } from './dto/create-cohort.dto.js';

@ApiTags('cohorts')
@ApiBearerAuth()
// SessionGuard authenticates and sets req.user; AdminGuard reads it. Guards
// run left to right, so the order matters.
@UseGuards(SessionGuard, AdminGuard)
@Controller('cohorts')
export class CohortsController {
  constructor(private readonly cohorts: CohortsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiCreateCohort()
  create(
    @Body() dto: CreateCohortDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<CohortResponseDto> {
    return this.cohorts.create(dto, { actorUserId: admin.id, correlationId });
  }

  @Get()
  @ApiListCohorts()
  list(
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<CohortResponseDto>> {
    return this.cohorts.list(query);
  }

  @Get(':id')
  @ApiGetCohort()
  get(@Param() params: CohortIdParamDto): Promise<CohortDetailResponseDto> {
    return this.cohorts.get(params.id);
  }

  @Post(':id/tracks')
  @HttpCode(HttpStatus.CREATED)
  @ApiAttachTrack()
  attachTrack(
    @Param() params: CohortIdParamDto,
    @Body() dto: AttachTrackDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<CohortTrackResponseDto> {
    return this.cohorts.attachTrack(params.id, dto.trackId, {
      actorUserId: admin.id,
      correlationId,
    });
  }
}
