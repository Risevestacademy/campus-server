import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import {
  CalendarConnectFailedError,
  CalendarUnavailableError,
} from './calendar.exceptions.js';
import { GOOGLE_CALENDAR_SCOPE, requireCalendar } from './calendar.settings.js';

/**
 * The fetch every request to Google goes through: fetchWithTimeout in the
 * module, so each one is a single attempt with one deadline.
 */
export const CALENDAR_FETCH = Symbol('CALENDAR_FETCH');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

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

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
}

interface GoogleAnswer {
  status: number;
  body: TokenResponse;
}

/** Google's OAuth endpoints, for the calendar alone. */
@Injectable()
export class GoogleCalendarClient {
  constructor(
    @Inject(CONFIG) private readonly config: Env,
    @Inject(CALENDAR_FETCH) private readonly fetch: typeof globalThis.fetch,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(GoogleCalendarClient.name);
  }

  /** Asks for the calendar alone, never folding in what sign-in was granted. */
  authorizationUrl(state: string, loginHint: string): string {
    const { clientId, callbackUrl } = requireCalendar(this.config);
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl,
      response_type: 'code',
      scope: `openid ${GOOGLE_CALENDAR_SCOPE}`,
      access_type: 'offline',
      // Google hands over a refresh token only from its consent screen.
      prompt: 'consent',
      login_hint: loginHint,
      state,
    }).toString();
    return url.toString();
  }

  redeemWebCode(code: string): Promise<RedeemedCalendarCode> {
    return this.redeem(code, requireCalendar(this.config).callbackUrl);
  }

  /** A native app's server auth code was issued with no redirect URI. */
  redeemAppCode(serverAuthCode: string): Promise<RedeemedCalendarCode> {
    return this.redeem(serverAuthCode);
  }

  async refresh(refreshToken: string): Promise<CalendarAccessToken> {
    const { clientId, clientSecret } = requireCalendar(this.config);
    const answer = await this.post(TOKEN_URL, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });
    if (answer?.body.error === 'invalid_grant') {
      throw new GrantWithdrawnError();
    }
    const { access_token, expires_in } = answer?.body ?? {};
    if (answer?.status !== 200 || !access_token || !expires_in) {
      this.logger.error(
        { status: answer?.status, error: answer?.body.error },
        'google calendar token refresh failed',
      );
      throw new CalendarUnavailableError();
    }
    return { token: access_token, expiresAt: Date.now() + expires_in * 1000 };
  }

  /**
   * Ends the whole grant at Google, every token issued under it, and takes
   * campus off the account's connections. True once Google confirms, or
   * says there was nothing left to revoke. Needs nothing but the token, so
   * it works while the calendar is switched off.
   */
  async revoke(token: string | undefined): Promise<boolean> {
    if (!token) {
      return true;
    }
    const answer = await this.post(REVOKE_URL, { token });
    if (answer?.status === 200 || answer?.body.error === 'invalid_token') {
      return true;
    }
    this.logger.warn(
      { status: answer?.status, error: answer?.body.error },
      'google did not take the revocation',
    );
    return false;
  }

  private async redeem(
    code: string,
    redirectUri?: string,
  ): Promise<RedeemedCalendarCode> {
    const { clientId, clientSecret } = requireCalendar(this.config);
    const answer = await this.post(TOKEN_URL, {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    });
    if (!answer || answer.status >= 500) {
      throw new CalendarUnavailableError();
    }
    if (answer.status !== 200) {
      this.logger.warn(
        { status: answer.status, error: answer.body.error },
        'calendar code exchange refused',
      );
      throw new CalendarConnectFailedError('exchange_failed');
    }

    const tokens = answer.body;
    const subject = subjectOf(tokens.id_token, clientId);
    if (!subject) {
      // Whose calendar this is cannot be told, so it is not kept.
      await this.revoke(tokens.refresh_token ?? tokens.access_token);
      throw new CalendarConnectFailedError('exchange_failed');
    }
    return {
      subject,
      scopes: tokens.scope?.split(' ') ?? [],
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
    };
  }

  /** Null when Google could not be reached or did not answer in time. */
  private async post(
    url: string,
    form: Record<string, string>,
  ): Promise<GoogleAnswer | null> {
    let res: Response;
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form),
      });
    } catch (err) {
      this.logger.warn({ err }, 'google oauth unreachable');
      return null;
    }
    const body = (await res.json().catch(() => ({}))) as TokenResponse;
    return { status: res.status, body: body ?? {} };
  }
}

/**
 * The account an id_token names. Its signature is not checked: it came
 * straight from Google's token endpoint over TLS, in answer to this client's
 * secret, which OpenID Connect accepts in place of the signature (Core
 * 3.1.3.7). Issuer, audience and expiry are still checked.
 */
function subjectOf(
  idToken: string | undefined,
  clientId: string,
): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(idToken?.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { iss?: unknown; aud?: unknown; exp?: unknown; sub?: unknown };
    const fresh =
      typeof payload.exp === 'number' && payload.exp * 1000 > Date.now();
    return ISSUERS.includes(payload.iss as string) &&
      payload.aud === clientId &&
      fresh &&
      typeof payload.sub === 'string'
      ? payload.sub
      : null;
  } catch {
    return null;
  }
}
