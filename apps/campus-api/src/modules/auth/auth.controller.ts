import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import { ApiErrorResponseDto } from '../../shared/dto/index.js';
import { GoogleSignInFailedError } from './auth.exceptions.js';
import { AuthService } from './auth.service.js';
import { GoogleCallbackQueryDto } from './dto/google-callback.query.dto.js';
import { requireGoogleAuth } from './google-auth.settings.js';
import { GoogleOAuthService } from './google-oauth.service.js';
import { OAuthStateService } from './oauth-state.service.js';
import { SessionIssuer, type IssuedSession } from './session-issuer.js';
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
  @ApiOperation({
    summary: 'Complete Google sign-in',
    description:
      'Where Google returns the user. Verifies the request, resolves or ' +
      'creates the account behind the Google identity, and issues a session.',
  })
  @ApiResponse({
    status: 401,
    description: 'The request could not be verified against Google.',
    type: ApiErrorResponseDto,
  })
  @ApiResponse({
    status: 403,
    description:
      'INVITE_REQUIRED when nobody has invited this address, ' +
      'ACCOUNT_SUSPENDED when the account exists but is closed.',
    type: ApiErrorResponseDto,
  })
  async callback(
    @Query() query: GoogleCallbackQueryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<IssuedSession> {
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

    return outcome.kind === 'full_access'
      ? this.sessions.issueFullAccess(outcome.user)
      : this.sessions.issueProvisional(outcome.user, outcome.invite);
  }
}
