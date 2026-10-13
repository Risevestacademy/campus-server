import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PinoLogger } from 'nestjs-pino';

import { AdminGuard } from '../../shared/auth/admin.guard.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import {
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../../shared/dto/index.js';
import { CorrelationId } from '../../shared/http/correlation-id.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { SessionIssuer } from '../auth/session-issuer.js';
import { CohortMembersService } from './cohort-members.service.js';
import { CohortRosterService } from './cohort-roster.service.js';
import { MembershipSessionsNotRevokedException } from './cohorts.exceptions.js';
import { CohortsService } from './cohorts.service.js';
import {
  ApiAttachTrack,
  ApiCreateCohort,
  ApiDeferMember,
  ApiDeleteCohort,
  ApiDetachTrack,
  ApiDismissMember,
  ApiExtendGuestVisit,
  ApiGetCohort,
  ApiGraduateMember,
  ApiListCohorts,
  ApiListRoster,
  ApiRemoveMember,
  ApiUpdateCohort,
  ApiWithdrawMember,
} from './docs/cohorts.docs.js';
import {
  AttachTrackDto,
  CohortIdParamDto,
  CohortTrackParamDto,
} from './dto/attach-track.dto.js';
import {
  CohortDetailResponseDto,
  CohortMemberResponseDto,
  CohortResponseDto,
  CohortTrackResponseDto,
} from './dto/cohort-response.dto.js';
import {
  ListRosterQueryDto,
  RosterMemberDto,
} from './dto/cohort-roster.dto.js';
import { CreateCohortDto } from './dto/create-cohort.dto.js';
import {
  EndMembershipDto,
  MembershipEndAction,
} from './dto/end-membership.dto.js';
import type { EndMembershipResponseDto } from './dto/end-membership.dto.js';
import { ExtendGuestVisitDto, MemberParamDto } from './dto/extend-visit.dto.js';
import { UpdateCohortDto } from './dto/update-cohort.dto.js';

@ApiTags('cohorts')
@ApiBearerAuth()
// SessionGuard authenticates and sets req.user; AdminGuard reads it. Guards
// run left to right, so the order matters.
@UseGuards(SessionGuard, AdminGuard)
@Controller('cohorts')
export class CohortsController {
  constructor(
    private readonly cohorts: CohortsService,
    private readonly members: CohortMembersService,
    private readonly roster: CohortRosterService,
    private readonly sessions: SessionIssuer,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CohortsController.name);
  }

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

  @Get(':id/members')
  @ApiListRoster()
  listMembers(
    @Param() params: CohortIdParamDto,
    @Query() query: ListRosterQueryDto,
  ): Promise<PaginatedResponseDto<RosterMemberDto>> {
    return this.roster.list(params.id, query);
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

  @Delete(':id/tracks/:trackId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiDetachTrack()
  detachTrack(
    @Param() params: CohortTrackParamDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<void> {
    return this.cohorts.detachTrack(params.id, params.trackId, {
      actorUserId: admin.id,
      correlationId,
    });
  }

  @Patch(':cohortId/members/:userId')
  @ApiExtendGuestVisit()
  extendVisit(
    @Param() params: MemberParamDto,
    @Body() dto: ExtendGuestVisitDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<CohortMemberResponseDto> {
    return this.members.extendGuestVisit(
      params.cohortId,
      params.userId,
      new Date(dto.accessExpiresAt),
      { actorUserId: admin.id, correlationId },
    );
  }

  @Post(':cohortId/members/:userId/dismiss')
  @HttpCode(HttpStatus.OK)
  @ApiDismissMember()
  dismiss(
    @Param() params: MemberParamDto,
    @Body() dto: EndMembershipDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<EndMembershipResponseDto> {
    return this.end(
      params,
      dto,
      admin,
      correlationId,
      MembershipEndAction.Dismiss,
    );
  }

  @Post(':cohortId/members/:userId/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiWithdrawMember()
  withdraw(
    @Param() params: MemberParamDto,
    @Body() dto: EndMembershipDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<EndMembershipResponseDto> {
    return this.end(
      params,
      dto,
      admin,
      correlationId,
      MembershipEndAction.Withdraw,
    );
  }

  @Post(':cohortId/members/:userId/defer')
  @HttpCode(HttpStatus.OK)
  @ApiDeferMember()
  defer(
    @Param() params: MemberParamDto,
    @Body() dto: EndMembershipDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<EndMembershipResponseDto> {
    return this.end(
      params,
      dto,
      admin,
      correlationId,
      MembershipEndAction.Defer,
    );
  }

  @Post(':cohortId/members/:userId/graduate')
  @HttpCode(HttpStatus.OK)
  @ApiGraduateMember()
  graduate(
    @Param() params: MemberParamDto,
    @Body() dto: EndMembershipDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<EndMembershipResponseDto> {
    return this.end(
      params,
      dto,
      admin,
      correlationId,
      MembershipEndAction.Graduate,
    );
  }

  @Post(':cohortId/members/:userId/remove')
  @HttpCode(HttpStatus.OK)
  @ApiRemoveMember()
  removeMember(
    @Param() params: MemberParamDto,
    @Body() dto: EndMembershipDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<EndMembershipResponseDto> {
    return this.end(
      params,
      dto,
      admin,
      correlationId,
      MembershipEndAction.Remove,
    );
  }

  /**
   * Every end route shares this: the members service owns the transaction
   * that writes the end, and the revocation happens here, after it has
   * committed, so a revocation that fails cannot roll the end back.
   *
   * A revocation that fails leaves the membership ended — the commit stands —
   * and is reported as its own 5xx, so the caller is told the real state
   * rather than either a success that hides a live session or a generic
   * failure that hides what did happen.
   */
  private async end(
    params: MemberParamDto,
    dto: EndMembershipDto,
    admin: AuthenticatedUser,
    correlationId: string | undefined,
    action: MembershipEndAction,
  ): Promise<EndMembershipResponseDto> {
    const result = await this.members.endMembership(
      params.cohortId,
      params.userId,
      action,
      dto.reason,
      { actorUserId: admin.id, correlationId },
    );
    try {
      await this.sessions.revokeAllSessions(params.userId);
    } catch (err) {
      // Log the fault with the membership it was about, and never the
      // tokens: revoking takes none. The end is already committed, so this
      // does not roll back — it names the half-done state for whoever reads
      // the logs.
      this.logger.error(
        {
          err,
          userId: params.userId,
          cohortId: params.cohortId,
          membershipId: result.id,
        },
        'membership ended but its sessions were not revoked',
      );
      throw new MembershipSessionsNotRevokedException(
        params.cohortId,
        params.userId,
        result.id,
      );
    }
    return result;
  }

  @Patch(':id')
  @ApiUpdateCohort()
  update(
    @Param() params: CohortIdParamDto,
    @Body() dto: UpdateCohortDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<CohortResponseDto> {
    return this.cohorts.update(params.id, dto, {
      actorUserId: admin.id,
      correlationId,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiDeleteCohort()
  remove(
    @Param() params: CohortIdParamDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<void> {
    return this.cohorts.remove(params.id, {
      actorUserId: admin.id,
      correlationId,
    });
  }
}
