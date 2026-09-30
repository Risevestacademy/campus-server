import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SessionScope, type SessionClaims } from '@campus/session';
import type { Request, Response } from 'express';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import { ApiErrorResponseDto } from '../../shared/dto/index.js';
import { CohortMembersService } from '../cohorts/cohort-members.service.js';
import { UsersService } from '../users/users.service.js';
import {
  GoogleSignInFailedError,
  SessionUnauthorizedError,
} from './auth.exceptions.js';
import { AuthService } from './auth.service.js';
import { CurrentSession } from './current-session.decorator.js';
import { GoogleCallbackQueryDto } from './dto/google-callback.query.dto.js';
import { requireGoogleAuth } from './google-auth.settings.js';
import { RefreshResponseDto } from './dto/refresh-response.dto.js';
import { SessionResponseDto } from './dto/session-response.dto.js';
import { GoogleOAuthService } from './google-oauth.service.js';
import { OAuthStateService } from './oauth-state.service.js';
import { SessionIssuer } from './session-issuer.js';
import {
  clearSessionCookies,
  cookieSite,
  readRefreshCookie,
  setSessionCookies,
} from './session-cookie.js';
import { assertAllowedOrigin } from './session-origin.js';
import { AnySessionGuard } from './session.guard.js';
import { SignInRedirectFilter } from './sign-in-redirect.filter.js';
import {
  STATE_COOKIE,
  STATE_COOKIE_PATH,
  readStateCookie,
  stateCookieOptions,
} from './state-cookie.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly state: OAuthStateService,
    private readonly google: GoogleOAuthService,
    private readonly sessions: SessionIssuer,
    private readonly users: UsersService,
    private readonly members: CohortMembersService,
    @Inject(CONFIG) private readonly config: Env,
  ) {}

  @Get('google')
  @ApiOperation({
    summary: 'Start Google sign-in',
    description:
      'Redirects to the Google consent screen and leaves a short-lived, ' +
      'httpOnly cookie behind so the callback can prove it reached the same ' +
      'browser. Open it as a top-level navigation, not with fetch.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to Google.' })
  start(@Res() res: Response): void {
    const { callbackUrl } = requireGoogleAuth(this.config);
    const { state, nonce } = this.state.issue();

    res.cookie(STATE_COOKIE, nonce, stateCookieOptions(callbackUrl));
    res.redirect(this.google.buildAuthorizationUrl(state));
  }

  @Get('google/callback')
  @UseFilters(SignInRedirectFilter)
  @ApiOperation({
    summary: 'Complete Google sign-in',
    description:
      'Where Google returns the user. Verifies the request, resolves or ' +
      'creates the account behind the Google identity, and issues a session. ' +
      'Every outcome is a redirect into the web app, failures included.',
  })
  @ApiResponse({
    status: 302,
    description:
      'On success, sets the session cookie and redirects to /invitation ' +
      'when an invite is still to be answered, otherwise to /. On failure, ' +
      'redirects to /sign-in?error=<code>, where code is one of ' +
      'invite_required, account_suspended, denied, invalid_state, ' +
      'expired_state, missing_code, exchange_failed, unverified_email, ' +
      'incomplete_profile, invalid_request, rate_limited, server_error.',
  })
  @ApiResponse({
    status: 404,
    description: 'Google sign-in is switched off on this deployment.',
    type: ApiErrorResponseDto,
  })
  async callback(
    @Query() query: GoogleCallbackQueryDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // Asked first, so a deployment without Google sign-in answers both routes
    // the same way instead of reporting a state problem it never had.
    requireGoogleAuth(this.config);

    const nonce = readStateCookie(req.headers.cookie);
    // One sign-in per issued state, whichever way this request ends.
    res.clearCookie(STATE_COOKIE, { path: STATE_COOKIE_PATH });

    this.state.verify(query.state, nonce);

    if (query.error) {
      throw new GoogleSignInFailedError('denied');
    }
    if (!query.code) {
      throw new GoogleSignInFailedError('missing_code');
    }

    const outcome = await this.auth.completeGoogleSignIn(query.code);
    const session =
      outcome.kind === 'full_access'
        ? await this.sessions.issueFullAccess(outcome.user, outcome.grant)
        : await this.sessions.issueProvisional(outcome.user, outcome.invite);

    // This is a top-level browser navigation, so the answer is a redirect and
    // a cookie, not a JSON body the user would be left staring at. The token
    // never reaches the page itself, and never reaches browser history.
    setSessionCookies(res, cookieSite(this.config), session);
    res.redirect(
      `${this.config.APP_PUBLIC_URL.replace(/\/+$/, '')}${session.redirectPath}`,
    );
  }

  @Get('me')
  @UseGuards(AnySessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Who is signed in',
    description:
      'The session behind the cookie and the account it belongs to. The ' +
      'cookie is httpOnly, so this is how the web app learns whether anyone ' +
      'is signed in, and whether they belong in onboarding or the campus. ' +
      'Accepts either kind of session.',
  })
  @ApiResponse({ status: 200, type: SessionResponseDto })
  @ApiResponse({
    status: 401,
    description:
      'No usable session. For a full-access session, try POST ' +
      '/v1/auth/refresh once before sending the user to sign in.',
    type: ApiErrorResponseDto,
  })
  async me(
    @CurrentSession() session: SessionClaims,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<SessionResponseDto> {
    const [user, membership] = await Promise.all([
      this.users.findById(current.id),
      session.scope === SessionScope.FullAccess
        ? this.members.resolveActiveMembership(current.id)
        : null,
    ]);
    if (!user) {
      // The guard read this row a moment ago; it went away underneath us.
      throw new SessionUnauthorizedError('Session is not usable');
    }

    return {
      scope: session.scope,
      expiresAt: session.expiresAt,
      inviteId: session.inviteId ?? null,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        systemRole: user.systemRole,
      },
      membership,
    };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh the access session',
    description:
      'Rotates both cookies and issues a new full-access session. The body ' +
      'says when the new tokens lapse, so the next refresh can be scheduled ' +
      'rather than guessed; the tokens themselves stay in the cookies.',
  })
  @ApiResponse({ status: 200, type: RefreshResponseDto })
  @ApiResponse({
    status: 401,
    description:
      'The refresh token is missing, spent, revoked or expired, or the ' +
      'account no longer has access. Send the user to sign in.',
    type: ApiErrorResponseDto,
  })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RefreshResponseDto> {
    const token = readRefreshCookie(req.headers.cookie);
    if (!token) {
      throw new SessionUnauthorizedError('Refresh token required');
    }

    assertAllowedOrigin(this.config, req.headers.origin);
    const session = await this.sessions.refreshSession(token);
    setSessionCookies(res, cookieSite(this.config), session);

    return {
      expiresAt: session.expiresAt,
      refreshExpiresAt: session.refreshExpiresAt,
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke the refresh session',
    description: 'Revokes the refresh cookie and clears both session cookies.',
  })
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    assertAllowedOrigin(this.config, req.headers.origin);
    const token = readRefreshCookie(req.headers.cookie);
    if (token) {
      await this.sessions.revokeRefreshToken(token);
    }
    clearSessionCookies(res, cookieSite(this.config));
  }
}
