import { Inject, Injectable } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { PinoLogger } from 'nestjs-pino';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import type { GoogleIdentity } from '../users/google-identity.js';
import { GoogleSignInFailedError } from './auth.exceptions.js';
import { requireGoogleAuth } from './google-auth.settings.js';

/** OpenID Connect plus the two profile claims the campus actually displays. */
const SCOPES = ['openid', 'email', 'profile'];

export interface VerifiedGoogleIdentity extends GoogleIdentity {
  emailVerified: boolean;
}


@Injectable()
export class GoogleOAuthService {
  private cached?: { client: OAuth2Client; clientId: string };

  constructor(
    @Inject(CONFIG) private readonly config: Env,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(GoogleOAuthService.name);
  }

  private get google(): { client: OAuth2Client; clientId: string } {
    if (!this.cached) {
      const settings = requireGoogleAuth(this.config);
      this.cached = {
        clientId: settings.clientId,
        client: new OAuth2Client({
          clientId: settings.clientId,
          clientSecret: settings.clientSecret,
          redirectUri: settings.callbackUrl,
        }),
      };
    }
    return this.cached;
  }

  buildAuthorizationUrl(state: string): string {
    return this.google.client.generateAuthUrl({
      scope: SCOPES,
      state,
      prompt: 'select_account',
    });
  }

  async exchangeCode(code: string): Promise<VerifiedGoogleIdentity> {
    const idToken = await this.redeem(code);
    const payload = await this.verify(idToken);

    if (!payload.sub || !payload.email) {
      throw new GoogleSignInFailedError('incomplete_profile');
    }

    return {
      subject: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
      firstName: payload.given_name ?? null,
      lastName: payload.family_name ?? null,
      displayName: payload.name ?? null,
      avatarUrl: payload.picture ?? null,
    };
  }

  private async redeem(code: string): Promise<string> {
    try {
      const { tokens } = await this.google.client.getToken(code);
      if (!tokens.id_token) {
        throw new Error('no id_token in token response');
      }
      return tokens.id_token;
    } catch (err) {
      // The caller only ever sees 'exchange_failed'. A misconfigured client
      // id or an unregistered redirect URI is indistinguishable from a stale
      // code out there, so the cause has to be written down here.
      this.logger.error({ err }, 'google token exchange failed');
      throw new GoogleSignInFailedError('exchange_failed');
    }
  }

  private async verify(idToken: string) {
    const { client, clientId } = this.google;
    try {
      const ticket = await client.verifyIdToken({
        idToken,
        audience: clientId,
      });
      const payload = ticket.getPayload();
      if (!payload) {
        throw new Error('empty id_token payload');
      }
      return payload;
    } catch (err) {
      this.logger.error({ err }, 'google id_token verification failed');
      throw new GoogleSignInFailedError('exchange_failed');
    }
  }
}
