import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import { AdminGuard } from '../../shared/auth/admin.guard.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import { CurrentSession } from '../auth/current-session.decorator.js';
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
  ProvisionalSessionGuard,
  SessionGuard,
} from '../auth/session.guard.js';
import { ApiCreateInvite } from './docs/create-invite.docs.js';
import { ApiDecideInvite } from './docs/decide-invite.docs.js';
import { ApiPreviewInvite } from './docs/preview-invite.docs.js';
import { ApiValidateUserInvite } from './docs/validate-invite.docs.js';
import { CreateInviteDto } from './dto/create-invite.dto.js';
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
import { InviteNotFoundException } from './invites.exceptions.js';

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
  ): Promise<InviteResponseDto> {
    const receipt = await this.invites.create(dto, inviter);
    // After the write, not inside it: a failed send must not undo an invite
    // the admin can still share by hand.
    return { ...receipt, emailStatus: await this.mailer.send(receipt) };
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

  // ProvisionalSessionGuard, not SessionGuard: the caller is mid-onboarding
  // and must not be able to reach the full-access half of the API by
  // holding a token that has not accepted an invite yet.
  @Get('validate-user-invite')
  @UseGuards(ProvisionalSessionGuard)
  @ApiBearerAuth()
  @ApiValidateUserInvite()
  async validateUserInvite(
    @CurrentSession() session: { inviteId?: string },
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InviteOnboardingResponseDto> {
    // issueProvisional always sets inviteId, but SessionClaims types it
    // optional for scopes that have no invite, so it is checked rather than
    // asserted.
    if (!session.inviteId) {
      throw new InviteNotFoundException('This session has no invite', {
        userId: user.id,
      });
    }
    return this.invites.getOnboardingInvite(session.inviteId, user);
  }

  @Post('decision')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProvisionalSessionGuard)
  @ApiBearerAuth()
  @ApiDecideInvite()
  async decide(
    @CurrentSession() session: { inviteId?: string },
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InviteDecisionDto,
    // passthrough keeps Nest serialising `response` below; a bare @Res would
    // hand body-writing to this method instead.
    @Res({ passthrough: true }) res: Response,
  ): Promise<InviteDecisionResponseDto> {
    if (!session.inviteId) {
      throw new InviteNotFoundException('This session has no invite', {
        userId: user.id,
      });
    }

    const outcome = await this.invites.decide(
      session.inviteId,
      dto.decision,
      user,
    );

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
      setSessionCookies(res, cookieSite(this.config), upgraded);
    } else {
      // A provisional session with nothing left to finish is a dead end, so
      // declining takes the cookie with it. The options are the same ones the
      // cookie was set with — a mismatched path or SameSite would leave it in
      // place.
      clearSessionCookies(res, cookieSite(this.config));
    }

    return outcome.response;
  }
}
