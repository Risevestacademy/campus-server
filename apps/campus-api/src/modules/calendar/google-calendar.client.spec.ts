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
const CALLBACK = 'http://localhost/v1/calendar/connect/callback';
const CONFIG = {
  FF_GOOGLE_AUTH_ENABLED: true,
  FF_GOOGLE_CALENDAR_ENABLED: true,
  GOOGLE_CLIENT_ID: 'web-client',
  GOOGLE_CLIENT_SECRET: 'web-secret',
  GOOGLE_CALENDAR_CALLBACK_URL: CALLBACK,
  AUTH_STATE_SECRET: 'a-state-secret-of-at-least-32-characters',
  GOOGLE_CALENDAR_TOKEN_KEY: Buffer.alloc(32).toString('base64'),
} as Env;

const fetch = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), setContext: vi.fn() };
const client = (config: Env = CONFIG) =>
  new GoogleCalendarClient(config, fetch, logger as unknown as PinoLogger);

function idToken(claims: Record<string, unknown> = {}): string {
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    part({ alg: 'RS256' }),
    part({
      iss: 'https://accounts.google.com',
      aud: 'web-client',
      sub: 'google-sub-1',
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...claims,
    }),
    'signature',
  ].join('.');
}

const answer = (status: number, body: object) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

function googleRedeems(tokens: Record<string, unknown> = {}): void {
  fetch.mockImplementation((url: string) =>
    url.endsWith('/revoke')
      ? answer(200, {})
      : answer(200, {
          id_token: idToken(),
          refresh_token: 'google-refresh',
          access_token: 'google-access',
          scope: `openid ${CALENDAR}`,
          ...tokens,
        }),
  );
}

const form = (call: number) =>
  Object.fromEntries(
    new URLSearchParams(
      String((fetch.mock.calls[call] as [string, RequestInit])[1].body),
    ),
  );

beforeEach(() => {
  vi.resetAllMocks();
});

describe('authorizationUrl', () => {
  it('asks for the calendar alone, read-only, offline, behind the consent screen', () => {
    const url = new URL(
      client().authorizationUrl('the-state', 'ada@campus.local'),
    );

    expect(url.origin + url.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'web-client',
      redirect_uri: CALLBACK,
      response_type: 'code',
      scope: `openid ${CALENDAR}`,
      access_type: 'offline',
      prompt: 'consent',
      login_hint: 'ada@campus.local',
      state: 'the-state',
    });
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

describe('redeeming a code', () => {
  it('names the Google account and what it granted', async () => {
    googleRedeems();

    await expect(client().redeemWebCode('code')).resolves.toEqual({
      subject: 'google-sub-1',
      scopes: ['openid', CALENDAR],
      refreshToken: 'google-refresh',
      accessToken: 'google-access',
    });
    expect(fetch.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
    expect(form(0)).toEqual({
      grant_type: 'authorization_code',
      code: 'code',
      client_id: 'web-client',
      client_secret: 'web-secret',
      redirect_uri: CALLBACK,
    });
  });

  it('redeems a native app’s code without a redirect URI', async () => {
    googleRedeems();

    await client().redeemAppCode('server-code');

    expect(form(0)).not.toHaveProperty('redirect_uri');
    expect(form(0).code).toBe('server-code');
  });

  it('reports a code Google refuses, and tries only once', async () => {
    fetch.mockImplementation(() => answer(400, { error: 'invalid_grant' }));

    await expect(client().redeemWebCode('code')).rejects.toMatchObject({
      constructor: CalendarConnectFailedError,
      reason: 'exchange_failed',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports Google unavailable when it fails or does not answer in time', async () => {
    fetch.mockImplementationOnce(() => answer(503, {}));
    await expect(client().redeemWebCode('code')).rejects.toThrow(
      CalendarUnavailableError,
    );

    fetch.mockImplementationOnce(() =>
      Promise.reject(new DOMException('timed out', 'TimeoutError')),
    );
    await expect(client().redeemAppCode('code')).rejects.toThrow(
      CalendarUnavailableError,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['no id_token', { id_token: undefined }],
    ['another audience', { id_token: idToken({ aud: 'other-app' }) }],
    ['another issuer', { id_token: idToken({ iss: 'https://evil.example' }) }],
    ['an expired one', { id_token: idToken({ exp: 1 }) }],
    ['one naming nobody', { id_token: idToken({ sub: undefined }) }],
  ])(
    'revokes what it got when it cannot tell whose it is: %s',
    async (_, tokens) => {
      googleRedeems(tokens);

      await expect(client().redeemAppCode('code')).rejects.toMatchObject({
        reason: 'exchange_failed',
      });
      expect(fetch.mock.calls[1][0]).toBe(
        'https://oauth2.googleapis.com/revoke',
      );
      expect(form(1)).toEqual({ token: 'google-refresh' });
    },
  );
});

describe('refresh', () => {
  it('trades the refresh token for an access token and its expiry', async () => {
    fetch.mockImplementation(() =>
      answer(200, { access_token: 'google-access', expires_in: 3599 }),
    );
    const before = Date.now();

    const { token, expiresAt } = await client().refresh('google-refresh');

    expect(token).toBe('google-access');
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3_599_000);
    expect(form(0)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'google-refresh',
    });
  });

  it('says so when Google has withdrawn the grant', async () => {
    fetch.mockImplementation(() => answer(400, { error: 'invalid_grant' }));

    await expect(client().refresh('google-refresh')).rejects.toThrow(
      GrantWithdrawnError,
    );
  });

  it('reports Google unavailable for anything else, after one try', async () => {
    fetch.mockImplementation(() => answer(500, {}));

    await expect(client().refresh('google-refresh')).rejects.toThrow(
      CalendarUnavailableError,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('revoke', () => {
  it('is confirmed when Google takes it', async () => {
    fetch.mockImplementation(() => answer(200, {}));

    await expect(client().revoke('google-refresh')).resolves.toBe(true);
    expect(form(0)).toEqual({ token: 'google-refresh' });
  });

  it('is confirmed when there was nothing left to revoke', async () => {
    fetch.mockImplementation(() => answer(400, { error: 'invalid_token' }));

    await expect(client().revoke('google-refresh')).resolves.toBe(true);
  });

  it('is not confirmed when Google fails or does not answer', async () => {
    fetch.mockImplementationOnce(() => answer(503, {}));
    await expect(client().revoke('google-refresh')).resolves.toBe(false);

    fetch.mockImplementationOnce(() =>
      Promise.reject(new TypeError('fetch failed')),
    );
    await expect(client().revoke('google-refresh')).resolves.toBe(false);
  });

  it('works while the calendar is switched off', async () => {
    fetch.mockImplementation(() => answer(200, {}));

    await expect(
      client({ ...CONFIG, FF_GOOGLE_CALENDAR_ENABLED: false }).revoke(
        'google-refresh',
      ),
    ).resolves.toBe(true);
  });

  it('has nothing to do without a token', async () => {
    await expect(client().revoke(undefined)).resolves.toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
