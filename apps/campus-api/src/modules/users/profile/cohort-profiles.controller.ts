import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedUser } from '../../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../../shared/auth/current-user.decorator.js';
import { SessionGuard } from '../../auth/session.guard.js';
import { CohortIdParamDto } from '../../cohorts/dto/attach-track.dto.js';
import { ApiListCohortProfiles } from './docs/profile.docs.js';
import type { CohortProfileDto } from './dto/profile.dto.js';
import { ProfileService } from './profile.service.js';

@ApiTags('profile')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('cohorts')
export class CohortProfilesController {
  constructor(private readonly profiles: ProfileService) {}

  @Get(':id/profiles')
  @ApiListCohortProfiles()
  list(
    @CurrentUser() viewer: AuthenticatedUser,
    @Param() params: CohortIdParamDto,
  ): Promise<CohortProfileDto[]> {
    return this.profiles.listCohort(viewer, params.id);
  }
}
