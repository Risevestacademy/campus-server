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
import { requireGoogleAuth } from '../auth/google-auth.settings.js';
import {
  SESSION_COOKIE,
  sessionCookieOptions,
} from '../auth/session-cookie.js';
import { SessionIssuer } from '../auth/session-issuer.js';
import {
  ProvisionalSessionGuard,
  SessionGuard,
} from '../auth/session.guard.js';
import { ApiCreateInvite } from './docs/create-invite.docs.js';
import { ApiDecideInvite } from './docs/decide-invite.docs.js';
import { ApiValidateUserInvite } from './docs/validate-invite.docs.js';
import { CreateInviteDto } from './dto/create-invite.dto.js';
import {
  InviteDecisionDto,
  InviteDecisionResponseDto,
} from './dto/invite-decision.dto.js';
import { InviteOnboardingResponseDto } from './dto/invite-onboarding-response.dto.js';
import { InviteResponseDto } from './dto/invite-response.dto.js';
import { InvitesService } from './invites.service.js';
import { InviteNotFoundException } from './invites.exceptions.js';

@ApiTags('invites')
@ApiBearerAuth()
@Controller('invites')
export class InvitesController {
  constructor(
    private readonly invites: InvitesService,
    private readonly sessions: SessionIssuer,
    @Inject(CONFIG) private readonly config: Env,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  // SessionGuard authenticates and puts req.user there; AdminGuard decides
  // whether that user may invite. Order matters — guards run left to right.
  @UseGuards(SessionGuard, AdminGuard)
  @ApiCreateInvite()
  create(
    @Body() dto: CreateInviteDto,
    @CurrentUser() inviter: AuthenticatedUser,
  ): Promise<InviteResponseDto> {
    return this.invites.create(dto, inviter);
  }

  // ProvisionalSessionGuard, not SessionGuard: the caller is mid-onboarding
  // and must not be able to reach the full-access half of the API by
  // holding a token that has not accepted an invite yet.
  @Get('validate-user-invite')
  @UseGuards(ProvisionalSessionGuard)
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

    const cookieBase = {
      apiUrl: requireGoogleAuth(this.config).callbackUrl,
      appUrl: this.config.APP_PUBLIC_URL,
    };

    if (outcome.kind === 'accepted') {
      const upgraded = await this.sessions.issueFullAccess(outcome.account);
      res.cookie(
        SESSION_COOKIE,
        upgraded.token,
        sessionCookieOptions(
          cookieBase.apiUrl,
          cookieBase.appUrl,
          upgraded.expiresAt,
        ),
      );
    } else {
      // A provisional session with nothing left to finish is a dead end, so
      // declining takes the cookie with it. The options are the same ones the
      // cookie was set with — a mismatched path or SameSite would leave it in
      // place.
      res.clearCookie(
        SESSION_COOKIE,
        sessionCookieOptions(cookieBase.apiUrl, cookieBase.appUrl, new Date(0)),
      );
    }

    return outcome.response;
  }
}
