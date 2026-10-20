import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { AdminGuard } from '../../shared/auth/admin.guard.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import { CorrelationId } from '../../shared/http/correlation-id.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import {
  ApiEndSpaceMembership,
  ApiGrantSpaceMembership,
  ApiListSpaceMemberships,
} from './docs/space-memberships.docs.js';
import type {
  GrantSpaceMembershipDto,
  SpaceMembershipResponseDto,
} from './dto/space-membership.dto.js';
import {
  MembershipIdParamDto,
  SpaceIdParamDto,
} from './dto/space-membership.dto.js';
import { SpaceMembershipsService } from './space-memberships.service.js';

/**
 * The admin side of who may enter a space: granting access, ending it, and
 * reading who holds it. A grant is to one person or one cohort track; the
 * rules that read these rows live with them, in @campus/space-access.
 */
@ApiTags('spaces')
@ApiBearerAuth()
// SessionGuard authenticates and sets req.user; AdminGuard reads it. Guards
// run left to right, so the order matters.
@UseGuards(SessionGuard, AdminGuard)
@Controller('spaces')
export class SpaceMembershipsController {
  constructor(private readonly memberships: SpaceMembershipsService) {}

  @Post(':id/memberships')
  @HttpCode(HttpStatus.CREATED)
  @ApiGrantSpaceMembership()
  grant(
    @Param() params: SpaceIdParamDto,
    @Body() dto: GrantSpaceMembershipDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<SpaceMembershipResponseDto> {
    return this.memberships.grant(params.id, dto, {
      actorUserId: admin.id,
      correlationId,
    });
  }

  @Delete(':id/memberships/:membershipId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiEndSpaceMembership()
  end(
    @Param() params: MembershipIdParamDto & SpaceIdParamDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<void> {
    return this.memberships.end(params.id, params.membershipId, {
      actorUserId: admin.id,
      correlationId,
    });
  }

  @Get(':id/memberships')
  @ApiListSpaceMemberships()
  list(
    @Param() params: SpaceIdParamDto,
  ): Promise<SpaceMembershipResponseDto[]> {
    // No actor to pass: the route is admin-only, and the log records
    // changes, not lookups.
    return this.memberships.list(params.id);
  }
}
