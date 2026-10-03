import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import { AdminGuard } from '../../shared/auth/admin.guard.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import { CorrelationId } from '../../shared/http/correlation-id.decorator.js';
import {
  CurrentSession,
  CurrentSessionTransport,
} from '../auth/current-session.decorator.js';
import { sessionTokens } from '../auth/dto/session-tokens.dto.js';
import type { PaginatedResponseDto } from '../../shared/dto/paginated-response.dto.js';
import {
  clearSessionCookies,
  cookieSite,
  setSessionCookies,
} from '../auth/session-cookie.js';
import { SessionUnauthorizedError } from '../auth/auth.exceptions.js';
import { SessionIssuer } from '../auth/session-issuer.js';
import { CohortMembersService } from '../cohorts/cohort-members.service.js';
import { isAdmin } from '../users/users.service.js';
import {
  AnySessionGuard,
  SessionGuard,
  type SessionTransport,
} from '../auth/session.guard.js';
import { SessionScope } from '@campus/session';
import { ApiCreateInvite } from './docs/create-invite.docs.js';
import { ApiDecideInvite } from './docs/decide-invite.docs.js';
import { ApiListInvites } from './docs/list-invites.docs.js';
import { ApiPreviewInvite } from './docs/preview-invite.docs.js';
import { ApiRevokeInvite } from './docs/revoke-invite.docs.js';
import { ApiValidateUserInvite } from './docs/validate-invite.docs.js';
import { CreateInviteDto } from './dto/create-invite.dto.js';
import {
  AdminInviteListItemDto,
  InviteIdParamDto,
  ListInvitesQueryDto,
} from './dto/invite-admin-list.dto.js';
import {
  InviteDecisionDto,
  InviteDecisionResponseDto,
} from './dto/invite-decision.dto.js';
import { InviteOnboardingResponseDto } from './dto/invite-onboarding-response.dto.js';
import {
  InvitePreviewRequestDto,
  InvitePreviewResponseDto,
} from './dto/invite-preview.dto.js';
import { InviteResponseDto } from './dto/invite-response.dto.js';
import { InviteMailer } from './invite-mailer.js';
import { InvitesService } from './invites.service.js';
import {
  InviteInvalidArgumentException,
  InviteNotFoundException,
} from './invites.exceptions.js';

@ApiTags('invites')
@Controller('invites')
export class InvitesController {
  constructor(
    private readonly invites: InvitesService,
    private readonly mailer: InviteMailer,
    private readonly sessions: SessionIssuer,
    private readonly members: CohortMembersService,
    @Inject(CONFIG) private readonly config: Env,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  // SessionGuard authenticates and puts req.user there; AdminGuard decides
  // whether that user may invite. Order matters — guards run left to right.
  @UseGuards(SessionGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiCreateInvite()
  async create(
    @Body() dto: CreateInviteDto,
    @CurrentUser() inviter: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<InviteResponseDto> {
    const receipt = await this.invites.create(dto, inviter, correlationId);
    // After the write, not inside it: a failed send must not undo an invite
    // the admin can still share by hand.
    return { ...receipt, emailStatus: await this.mailer.send(receipt) };
  }

  /**
   * The admin's view of the offers they have out.
   *
   * Declared before `validate-user-invite` so it cannot be shadowed by it, and
   * guarded exactly like create: an admin listing invites is no different from
   * an admin making one.
   */
  @Get()
  @UseGuards(SessionGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiListInvites()
  list(
    @Query() query: ListInvitesQueryDto,
  ): Promise<PaginatedResponseDto<AdminInviteListItemDto>> {
    return this.invites.list(query);
  }

  /**
   * Cancels a pending invite. Guarded like create, and it needs the actor to
   * record who revoked — the reason the columns exist.
   */
  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiRevokeInvite()
  revoke(
    @Param() params: InviteIdParamDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<AdminInviteListItemDto> {
    return this.invites.revoke(params.id, actor);
  }

  // No guard, and no @ApiBearerAuth: the invitee has not signed in yet. The
  // token is the credential, and all it opens is a read of the offer it was
  // issued for.
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @ApiPreviewInvite()
  preview(
    @Body() dto: InvitePreviewRequestDto,
  ): Promise<InvitePreviewResponseDto> {
    return this.invites.previewByToken(dto.token);
  }

  // Either kind of session: somebody mid-onboarding, or a member invited to
  // another cohort, who answers without giving up the access they have.
  // Opening these routes to full access opens nothing else to provisional.
  @Get('validate-user-invite')
  @UseGuards(AnySessionGuard)
  @ApiBearerAuth()
  @ApiValidateUserInvite()
  async validateUserInvite(
    @CurrentSession() session: InviteSession,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InviteOnboardingResponseDto> {
    const inviteId = await this.inviteToAnswer(session, user);
    return this.invites.getOnboardingInvite(inviteId, user);
  }

  @Post('decision')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AnySessionGuard)
  @ApiBearerAuth()
  @ApiDecideInvite()
  async decide(
    @CurrentSession() session: InviteSession,
    @CurrentSessionTransport() transport: SessionTransport,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InviteDecisionDto,
    @CorrelationId() correlationId: string | undefined,
    // passthrough keeps Nest serialising `response` below; a bare @Res would
    // hand body-writing to this method instead.
    @Res({ passthrough: true }) res: Response,
  ): Promise<InviteDecisionResponseDto> {
    const inviteId = await this.inviteToDecide(session, user, dto.inviteId);
    const outcome = await this.invites.decide(
      inviteId,
      dto.decision,
      user,
      new Date(),
      correlationId,
    );

    // A member keeps the session they came with either way. Accepting only
    // adds a membership, which can extend their access but never cut it
    // short, so the session they hold is still a true one.
    if (session.scope === SessionScope.FullAccess) {
      return outcome.response;
    }

    if (outcome.kind === 'accepted') {
      // Resolved after the transaction rather than taken from the invite:
      // the account may already hold other memberships, and the soonest of
      // them is what bounds the session. An admin is admitted on their role,
      // which nothing expires.
      const grant = isAdmin(outcome.account)
        ? { endsAt: null }
        : await this.members.resolveActiveAccess(outcome.account.id);
      if (!grant) {
        // The accept wrote a membership, so this cannot be reached by any
        // ordinary route — it would mean the row went away underneath us.
        throw new SessionUnauthorizedError('Access has already ended');
      }
      const upgraded = await this.sessions.issueFullAccess(
        outcome.account,
        grant,
      );
      // Answered the way it was asked: a client that sent a bearer token
      // holds its own tokens and has no cookie jar to put new ones in.
      if (transport === 'bearer') {
        return { ...outcome.response, session: sessionTokens(upgraded) };
      }
      setSessionCookies(res, cookieSite(this.config), upgraded);
    } else if (transport === 'cookie') {
      // A provisional session with nothing left to finish is a dead end, so
      // declining takes the cookie with it. The options are the same ones the
      // cookie was set with — a mismatched path or SameSite would leave it in
      // place.
      clearSessionCookies(res, cookieSite(this.config));
    }

    return outcome.response;
  }

  /**
   * Which invite this caller is answering. A provisional session carries the
   * one it was issued for, followed to its live replacement if that one has
   * since been revoked or lapsed. A full-access session carries none — it was
   * issued for a membership — so its invite is the pending one addressed to
   * the account, the same one sign-in found.
   */
  private async inviteToAnswer(
    session: InviteSession,
    user: AuthenticatedUser,
  ): Promise<string> {
    if (session.scope === SessionScope.Provisional) {
      return this.invites.currentInviteFor(
        sessionInvite(session, user),
        user.email,
      );
    }

    const invite = await this.invites.findUsableForEmail(user.email);
    if (!invite) {
      throw new InviteNotFoundException('No pending invite for this account', {
        userId: user.id,
      });
    }
    return invite.id;
  }

  /**
   * The invite a decision answers. Unlike a read, a decision must not be
   * resolved afresh for a member: an admin can revoke the invite they were
   * shown and send another between the read and the click, and a fresh
   * lookup would accept the new one unseen. So a member names the invite,
   * and the decision is about that one — a replaced invite then answers as
   * revoked, which is the truth.
   *
   * A provisional session is held to the same rule once it has moved on.
   * Unnamed, a decision answers the session's own invite, so a replacement is
   * never accepted unseen. Another invite may be named only when it is the
   * live replacement validate-user-invite is now showing.
   */
  private async inviteToDecide(
    session: InviteSession,
    user: AuthenticatedUser,
    named: string | undefined,
  ): Promise<string> {
    if (session.scope === SessionScope.Provisional) {
      const own = sessionInvite(session, user);
      if (named === undefined || named === own) {
        return own;
      }
      if (named !== (await this.invites.currentInviteFor(own, user.email))) {
        throw new InviteNotFoundException('No invite matches this session', {
          inviteId: named,
        });
      }
      return named;
    }

    if (named === undefined) {
      throw new InviteInvalidArgumentException('Request validation failed', {
        fields: {
          inviteId: 'inviteId is required when a member answers an invite',
        },
      });
    }
    if (!(await this.invites.isAddressedTo(named, user.email))) {
      throw new InviteNotFoundException('No invite matches this account', {
        inviteId: named,
      });
    }
    return named;
  }
}

type InviteSession = { scope: SessionScope; inviteId?: string };

/** The invite a provisional session was issued for. */
function sessionInvite(
  session: InviteSession,
  user: AuthenticatedUser,
): string {
  // issueProvisional always sets inviteId, but the claims type it optional
  // for scopes that have no invite, so it is checked rather than asserted.
  if (!session.inviteId) {
    throw new InviteNotFoundException('This session has no invite', {
      userId: user.id,
    });
  }
  return session.inviteId;
}
