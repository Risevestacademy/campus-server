import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { AdminGuard } from '../../shared/auth/admin.guard.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import type { PaginatedResponseDto } from '../../shared/dto/index.js';
import { CorrelationId } from '../../shared/http/correlation-id.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import {
  ApiGetSpace,
  ApiListSpaces,
  ApiUpdateSpace,
} from './docs/spaces.docs.js';
import {
  ListSpacesQueryDto,
  type SpaceResponseDto,
  UpdateSpaceDto,
} from './dto/space.dto.js';
import { SpaceIdParamDto } from './dto/space-membership.dto.js';
import { SpacesService } from './spaces.service.js';

/**
 * The admin side of what each space is and how it behaves. The map defines
 * which spaces exist; these routes decide what they are for. Who may enter a
 * designated space is the memberships routes' business.
 */
@ApiTags('spaces')
@ApiBearerAuth()
// SessionGuard authenticates and sets req.user; AdminGuard reads it. Guards
// run left to right, so the order matters.
@UseGuards(SessionGuard, AdminGuard)
@Controller('spaces')
export class SpacesController {
  constructor(private readonly spaces: SpacesService) {}

  @Get()
  @ApiListSpaces()
  list(
    @Query() query: ListSpacesQueryDto,
  ): Promise<PaginatedResponseDto<SpaceResponseDto>> {
    return this.spaces.list(query);
  }

  @Get(':id')
  @ApiGetSpace()
  get(@Param() params: SpaceIdParamDto): Promise<SpaceResponseDto> {
    return this.spaces.get(params.id);
  }

  @Patch(':id')
  @ApiUpdateSpace()
  update(
    @Param() params: SpaceIdParamDto,
    @Body() dto: UpdateSpaceDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<SpaceResponseDto> {
    return this.spaces.update(params.id, dto, {
      actorUserId: admin.id,
      correlationId,
    });
  }
}
