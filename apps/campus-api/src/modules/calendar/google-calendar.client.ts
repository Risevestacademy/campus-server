import { Inject, Injectable } from '@nestjs/common';
import { OAuth2Client, type OAuth2ClientOptions } from 'google-auth-library';
import { PinoLogger } from 'nestjs-pino';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import {
  CalendarConnectFailedError,
  CalendarUnavailableError,
} from './calendar.exceptions.js';
import { GOOGLE_CALENDAR_SCOPE, requireCalendar } from './calendar.settings.js';

const GOOGLE_TIMEOUT_MS = 5_000;

export interface RedeemedCalendarCode {
  subject: string;
  scopes: string[];
  refreshToken?: string;
  accessToken?: string;
}

export interface CalendarAccessToken {
  token: string;
  expiresAt: number;
}

/** Google has withdrawn the grant: revoked, expired, or the password changed. */
export class GrantWithdrawnError extends Error {}

/**
 * Google's OAuth endpoints, for the calendar alone: sign-in has its own
 * client in GoogleOAuthService.
 */
@Injectable()
export class GoogleCalendarClient {
  private cached?: {
    clientId: string;
    options: OAuth2ClientOptions;
    web: OAuth2Client;
    app: OAuth2Client;
  };
  private readonly bare = new OAuth2Client({
    transporterOptions: { timeout: GOOGLE_TIMEOUT_MS },
  });

  constructor(
    @Inject(CONFIG) private readonly config: Env,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(GoogleCalendarClient.name);
  }

  private get google() {
    if (!this.cached) {
      const settings = requireCalendar(this.config);
      const options: OAuth2ClientOptions = {
        clientId: settings.clientId,
        clientSecret: settings.clientSecret,
        transporterOptions: { timeout: GOOGLE_TIMEOUT_MS },
      };
      this.cached = {
        clientId: settings.clientId,
        options,
        web: new OAuth2Client({
          ...options,
          redirectUri: settings.callbackUrl,
        }),
        // A native app's server auth code was issued with no redirect URI,
        // and has to be redeemed without one.
        app: new OAuth2Client(options),
      };
    }
    return this.cached;
  }

  authorizationUrl(state: string, loginHint: string): string {
    return this.google.web.generateAuthUrl({
      scope: ['openid', GOOGLE_CALENDAR_SCOPE],
      access_type: 'offline',
      include_granted_scopes: true,
      // Google hands over a refresh token only from its consent screen.
      prompt: 'consent',
      login_hint: loginHint,
      state,
    });
  }

  async redeem(
    code: string,
    from: 'web' | 'app',
  ): Promise<RedeemedCalendarCode> {
    const { web, app, clientId } = this.google;
    let tokens;
    try {
      ({ tokens } = await (from === 'web' ? web : app).getToken(code));
    } catch (err) {
      this.logger.warn({ err, from }, 'calendar code exchange failed');
      throw new CalendarConnectFailedError('exchange_failed');
    }

    const refreshToken = tokens.refresh_token ?? undefined;
    const accessToken = tokens.access_token ?? undefined;
    let subject: string | undefined;
    try {
      if (tokens.id_token) {
        const ticket = await web.verifyIdToken({
          idToken: tokens.id_token,
          audience: clientId,
        });
        subject = ticket.getPayload()?.sub;
      }
    } catch (err) {
      this.logger.warn({ err }, 'calendar id_token did not verify');
    }
    if (!subject) {
      // Whose calendar this is cannot be told, so it is not kept.
      await this.revoke(refreshToken ?? accessToken);
      throw new CalendarConnectFailedError('exchange_failed');
    }

    return {
      subject,
      scopes: tokens.scope?.split(' ') ?? [],
      refreshToken,
      accessToken,
    };
  }

  async accessToken(refreshToken: string): Promise<CalendarAccessToken> {
    const client = new OAuth2Client(this.google.options);
    client.setCredentials({ refresh_token: refreshToken });
    let token: string | null | undefined;
    try {
      ({ token } = await client.getAccessToken());
    } catch (err) {
      if (oauthError(err) === 'invalid_grant') {
        throw new GrantWithdrawnError();
      }
      this.logger.error({ err }, 'google calendar token refresh failed');
      throw new CalendarUnavailableError();
    }
    if (!token) {
      throw new CalendarUnavailableError();
    }
    return { token, expiresAt: client.credentials.expiry_date ?? Date.now() };
  }

  /**
   * Ends the whole grant at Google, every token issued under it, and takes
   * campus off the account's connections. Works while the calendar is
   * switched off: revoking needs nothing but the token.
   */
  async revoke(token: string | undefined): Promise<void> {
    if (!token) {
      return;
    }
    try {
      await this.bare.revokeToken(token);
    } catch (err) {
      this.logger.warn({ err }, 'google did not take the revocation');
    }
  }
}

function oauthError(err: unknown): string | undefined {
  const data = (err as { response?: { data?: { error?: unknown } } })?.response
    ?.data;
  return typeof data?.error === 'string' ? data.error : undefined;
}
