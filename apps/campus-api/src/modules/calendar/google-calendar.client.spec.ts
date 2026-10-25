import { OAuth2Client } from 'google-auth-library';
import type { PinoLogger } from 'nestjs-pino';

import type { Env } from '../../infra/config/config.module.js';
import {
  CalendarConnectFailedError,
  CalendarNotConfiguredError,
  CalendarUnavailableError,
} from './calendar.exceptions.js';
import {
  GoogleCalendarClient,
  GrantWithdrawnError,
} from './google-calendar.client.js';

const CALENDAR = 'https://www.googleapis.com/auth/calendar.events.readonly';
const CONFIG = {
  FF_GOOGLE_AUTH_ENABLED: true,
  FF_GOOGLE_CALENDAR_ENABLED: true,
  GOOGLE_CLIENT_ID: 'web-client',
  GOOGLE_CLIENT_SECRET: 'web-secret',
  GOOGLE_CALENDAR_CALLBACK_URL: 'http://localhost/v1/calendar/connect/callback',
  AUTH_STATE_SECRET: 'a-state-secret-of-at-least-32-characters',
  GOOGLE_CALENDAR_TOKEN_KEY: Buffer.alloc(32).toString('base64'),
} as Env;

const logger = { warn: vi.fn(), error: vi.fn(), setContext: vi.fn() };
const client = (config: Env = CONFIG) =>
  new GoogleCalendarClient(config, logger as unknown as PinoLogger);

const getToken = vi.spyOn(OAuth2Client.prototype, 'getToken');
const verifyIdToken = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken');
const getAccessToken = vi.spyOn(OAuth2Client.prototype, 'getAccessToken');
const revokeToken = vi.spyOn(OAuth2Client.prototype, 'revokeToken');

function googleRedeems(tokens: Record<string, unknown>): void {
  getToken.mockImplementation(() => Promise.resolve({ tokens } as never));
}

beforeEach(() => {
  vi.resetAllMocks();
  verifyIdToken.mockResolvedValue({
    getPayload: () => ({ sub: 'google-sub-1' }),
  } as never);
  revokeToken.mockResolvedValue({} as never);
});

describe('authorizationUrl', () => {
  it('asks for read-only calendar access, offline, behind the consent screen', () => {
    const params = new URL(
      client().authorizationUrl('the-state', 'ada@campus.local'),
    ).searchParams;

    expect(params.get('scope')).toBe(`openid ${CALENDAR}`);
    expect(params.get('access_type')).toBe('offline');
    expect(params.get('prompt')).toBe('consent');
    expect(params.get('include_granted_scopes')).toBe('true');
    expect(params.get('login_hint')).toBe('ada@campus.local');
    expect(params.get('state')).toBe('the-state');
    expect(params.get('redirect_uri')).toBe(
      'http://localhost/v1/calendar/connect/callback',
    );
  });

  it('is not there while the calendar is switched off', () => {
    expect(() =>
      client({ ...CONFIG, FF_GOOGLE_CALENDAR_ENABLED: false }).authorizationUrl(
        's',
        'a@b.c',
      ),
    ).toThrow(CalendarNotConfiguredError);
  });
});

describe('redeem', () => {
  it('names the Google account and what it granted', async () => {
    googleRedeems({
      id_token: 'id-token',
      refresh_token: 'google-refresh',
      access_token: 'google-access',
      scope: `openid ${CALENDAR}`,
    });

    await expect(client().redeem('code', 'web')).resolves.toEqual({
      subject: 'google-sub-1',
      scopes: ['openid', CALENDAR],
      refreshToken: 'google-refresh',
      accessToken: 'google-access',
    });
    expect(verifyIdToken).toHaveBeenCalledWith({
      idToken: 'id-token',
      audience: 'web-client',
    });
  });

  it('redeems a native app’s code without the web redirect URI', async () => {
    const used: OAuth2Client[] = [];
    getToken.mockImplementation(function (this: OAuth2Client) {
      used.push(this);
      return Promise.resolve({
        tokens: { id_token: 'id-token', scope: CALENDAR },
      } as never);
    });

    await client().redeem('web-code', 'web');
    await client().redeem('app-code', 'app');

    expect((used[0] as unknown as { redirectUri?: string }).redirectUri).toBe(
      'http://localhost/v1/calendar/connect/callback',
    );
    expect(
      (used[1] as unknown as { redirectUri?: string }).redirectUri,
    ).toBeUndefined();
  });

  it('reports a code Google will not take', async () => {
    getToken.mockRejectedValue(new Error('invalid_grant'));

    await expect(client().redeem('code', 'web')).rejects.toMatchObject({
      constructor: CalendarConnectFailedError,
      reason: 'exchange_failed',
    });
    expect(revokeToken).not.toHaveBeenCalled();
  });

  it('revokes what it got when it cannot tell whose it is', async () => {
    googleRedeems({ refresh_token: 'google-refresh', scope: CALENDAR });

    await expect(client().redeem('code', 'app')).rejects.toMatchObject({
      reason: 'exchange_failed',
    });
    expect(revokeToken).toHaveBeenCalledWith('google-refresh');
  });

  it('revokes what it got when the id_token does not verify', async () => {
    googleRedeems({
      id_token: 'forged',
      refresh_token: 'google-refresh',
      scope: CALENDAR,
    });
    verifyIdToken.mockRejectedValue(new Error('Wrong recipient'));

    await expect(client().redeem('code', 'app')).rejects.toMatchObject({
      reason: 'exchange_failed',
    });
    expect(revokeToken).toHaveBeenCalledWith('google-refresh');
  });
});

describe('accessToken', () => {
  it('trades the refresh token for an access token and its expiry', async () => {
    getAccessToken.mockImplementation(function (this: OAuth2Client) {
      this.credentials = { ...this.credentials, expiry_date: 1234 };
      return Promise.resolve({ token: 'google-access' }) as never;
    });

    await expect(client().accessToken('google-refresh')).resolves.toEqual({
      token: 'google-access',
      expiresAt: 1234,
    });
  });

  it('says so when Google has withdrawn the grant', async () => {
    getAccessToken.mockRejectedValue(
      Object.assign(new Error('invalid_grant'), {
        response: { data: { error: 'invalid_grant' } },
      }),
    );

    await expect(client().accessToken('google-refresh')).rejects.toThrow(
      GrantWithdrawnError,
    );
  });

  it('reports Google unavailable for any other failure', async () => {
    getAccessToken.mockRejectedValue(new Error('timeout of 5000ms exceeded'));

    await expect(client().accessToken('google-refresh')).rejects.toThrow(
      CalendarUnavailableError,
    );
  });
});

describe('revoke', () => {
  it('works while the calendar is switched off', async () => {
    await client({ ...CONFIG, FF_GOOGLE_CALENDAR_ENABLED: false }).revoke(
      'google-refresh',
    );

    expect(revokeToken).toHaveBeenCalledWith('google-refresh');
  });

  it('swallows a refusal: the grant is gone here either way', async () => {
    revokeToken.mockRejectedValue(new Error('invalid_token'));

    await expect(client().revoke('google-refresh')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('does nothing without a token', async () => {
    await client().revoke(undefined);

    expect(revokeToken).not.toHaveBeenCalled();
  });
});
