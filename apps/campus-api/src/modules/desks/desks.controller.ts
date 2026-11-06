import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import { CorrelationId } from '../../shared/http/correlation-id.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { DesksService } from './desks.service.js';
import {
  ApiClaimDesk,
  ApiListDesks,
  ApiReleaseDesk,
} from './docs/desks.docs.js';
import { DeskCohortParamDto, DeskDto, DeskParamDto } from './dto/desk.dto.js';

@ApiTags('desks')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('cohorts/:cohortId/desks')
export class DesksController {
  constructor(private readonly desks: DesksService) {}

  @Get()
  @ApiListDesks()
  list(
    @Param() params: DeskCohortParamDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeskDto[]> {
    return this.desks.list(user, params.cohortId);
  }

  @Post(':key/claim')
  @HttpCode(HttpStatus.OK)
  @ApiClaimDesk()
  claim(
    @Param() params: DeskParamDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeskDto> {
    return this.desks.claim(user, params.cohortId, params.key);
  }

  @Post(':key/release')
  @HttpCode(HttpStatus.OK)
  @ApiReleaseDesk()
  release(
    @Param() params: DeskParamDto,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<DeskDto> {
    return this.desks.release(user, params.cohortId, params.key, {
      actorUserId: user.id,
      correlationId,
    });
  }
}
