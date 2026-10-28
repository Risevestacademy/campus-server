import { SessionScope } from '@campus/session';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { buildWorld, type World } from '../app.js';
import {
  ORIGIN,
  routeAccounts,
  routeEnv,
  sessionToken,
} from '../http/routes.testing.js';
import { CONNECTION_CHECK_PATH } from './connection-check.js';

const MEDIA = {
  LIVEKIT_URL: 'ws://localhost:7880',
  LIVEKIT_API_KEY: 'devkey',
  LIVEKIT_API_SECRET: 'local-dev-secret-not-for-production-use',
};

const accounts = routeAccounts();
accounts.gone.add('gone');

/** The payload of a LiveKit token, once its signature has been checked. */
function livekitClaims(jwt: string, secret: string) {
  const [header, payload, signature] = jwt.split('.');
  const expected = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  expect(signature).toBe(expected);
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    sub: string;
    exp: number;
    nbf: number;
    video: Record<string, unknown>;
  };
}

describe('POST /media/connection-check', () => {
  let world: World | undefined;

  async function start(env = routeEnv(MEDIA)) {
    world = await buildWorld({ env, accounts });
    return world.app;
  }

  async function ask(
    headers: Record<string, string>,
    env?: ReturnType<typeof routeEnv>,
  ) {
    const app = world?.app ?? (await start(env));
    return app.inject({ method: 'POST', url: CONNECTION_CHECK_PATH, headers });
  }

  afterEach(async () => {
    accounts.suspended.clear();
    await world?.gateway.stop();
    await world?.app.close();
    world = undefined;
  });

  it('gives a signed-in member a token for a room of their own', async () => {
    const response = await ask({
      origin: ORIGIN,
      cookie: `campus_session=${await sessionToken()}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json();
    expect(body).toMatchObject({
      url: MEDIA.LIVEKIT_URL,
      room: expect.stringMatching(/^connection-check-[0-9a-f-]{36}$/),
    });

    const claims = livekitClaims(body.token, MEDIA.LIVEKIT_API_SECRET);
    expect(claims.sub).toBe('ada');
    expect(claims.video).toEqual({
      room: body.room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });
    // Two minutes: long enough to run the check, useless soon after.
    expect(claims.exp - claims.nbf).toBe(120);
    expect(new Date(body.expiresAt).getTime()).toBe(claims.exp * 1000);
  });

  it('never puts two checks in the same room', async () => {
    const cookie = `campus_session=${await sessionToken()}`;

    const first = await ask({ origin: ORIGIN, cookie });
    const second = await ask({ origin: ORIGIN, cookie });

    expect(first.json().room).not.toBe(second.json().room);
  });

  it('takes a bearer token from a caller that is not a browser', async () => {
    const response = await ask({
      authorization: `Bearer ${await sessionToken()}`,
    });

    expect(response.statusCode).toBe(200);
  });

  describe('who is refused', () => {
    it.each([
      ['nobody signed in', async () => ({ origin: ORIGIN }), 'no_token'],
      [
        'somebody still onboarding',
        async () => ({
          origin: ORIGIN,
          cookie: `campus_session=${await sessionToken('ada', SessionScope.Provisional)}`,
        }),
        'wrong_scope',
      ],
      [
        'a token for an account that is gone',
        async () => ({
          authorization: `Bearer ${await sessionToken('gone')}`,
        }),
        'account_gone',
      ],
      [
        'a token that is not one',
        async () => ({ authorization: 'Bearer not-a-token' }),
        'token_not_usable',
      ],
    ])('%s, with 401', async (_, headers, reason) => {
      const response = await ask(await headers());

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          details: { reason },
        },
      });
    });

    it('a suspended account, with 401', async () => {
      accounts.suspended.add('ada');

      const response = await ask({
        authorization: `Bearer ${await sessionToken()}`,
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().error.details.reason).toBe('account_suspended');
    });

    // The cookie is sent by the browser whatever page asked, so the origin
    // is what tells the web app from anybody else's.
    it('a page world does not serve, with 403 and no CORS grant', async () => {
      const response = await ask({
        origin: 'https://elsewhere.example',
        cookie: `campus_session=${await sessionToken()}`,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('a cookie with no origin, which no browser sends', async () => {
      const response = await ask({
        cookie: `campus_session=${await sessionToken()}`,
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('without a media server', () => {
    it('tells a member that audio and video are not set up here', async () => {
      const response = await ask(
        { authorization: `Bearer ${await sessionToken()}` },
        routeEnv(),
      );

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: {
          code: 'MEDIA_NOT_CONFIGURED',
          message: 'Audio and video are not set up on this deployment.',
        },
      });
    });

    it('tells somebody not signed in nothing about it', async () => {
      const response = await ask({ origin: ORIGIN }, routeEnv());

      expect(response.statusCode).toBe(401);
    });
  });

  describe('rate limit', () => {
    const limited = () =>
      routeEnv({ ...MEDIA, WORLD_CONNECTION_CHECKS_PER_MINUTE: '2' });

    it('refuses an account past its budget, saying when to come back', async () => {
      await start(limited());
      const headers = { authorization: `Bearer ${await sessionToken()}` };

      expect((await ask(headers)).statusCode).toBe(200);
      expect((await ask(headers)).statusCode).toBe(200);
      const refused = await ask(headers);

      expect(refused.statusCode).toBe(429);
      expect(refused.json().error.code).toBe('RATE_LIMITED');
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(refused.headers['retry-after'])).toBeLessThanOrEqual(60);
    });

    it('counts per account, not for everybody', async () => {
      await start(limited());
      const ada = { authorization: `Bearer ${await sessionToken('ada')}` };
      const grace = { authorization: `Bearer ${await sessionToken('grace')}` };

      await ask(ada);
      await ask(ada);
      expect((await ask(ada)).statusCode).toBe(429);

      expect((await ask(grace)).statusCode).toBe(200);
    });

    it('spends nothing on callers it refuses at the door', async () => {
      await start(limited());

      for (let i = 0; i < 3; i++) {
        expect((await ask({ authorization: 'Bearer nope' })).statusCode).toBe(
          401,
        );
      }
      expect(
        (await ask({ authorization: `Bearer ${await sessionToken()}` }))
          .statusCode,
      ).toBe(200);
    });
  });

  describe('CORS', () => {
    it('lets the web app read the answer, with its credentials', async () => {
      const response = await ask({
        origin: ORIGIN,
        cookie: `campus_session=${await sessionToken()}`,
      });

      expect(response.headers).toMatchObject({
        'access-control-allow-origin': ORIGIN,
        'access-control-allow-credentials': 'true',
        vary: 'Origin',
      });
      expect(response.headers['access-control-expose-headers']).toContain(
        'retry-after',
      );
    });

    it('answers the preflight for an allowed origin only', async () => {
      const app = await start();

      const allowed = await app.inject({
        method: 'OPTIONS',
        url: CONNECTION_CHECK_PATH,
        headers: {
          origin: ORIGIN,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization',
        },
      });
      expect(allowed.statusCode).toBe(204);
      expect(allowed.headers).toMatchObject({
        'access-control-allow-origin': ORIGIN,
        'access-control-allow-credentials': 'true',
        'access-control-allow-methods': 'POST',
      });
      expect(allowed.headers['access-control-allow-headers']).toContain(
        'authorization',
      );
      expect(allowed.headers['access-control-allow-headers']).toContain(
        'content-type',
      );

      const other = await app.inject({
        method: 'OPTIONS',
        url: CONNECTION_CHECK_PATH,
        headers: {
          origin: 'https://elsewhere.example',
          'access-control-request-method': 'POST',
        },
      });
      expect(other.headers['access-control-allow-origin']).toBeUndefined();
      expect(other.headers['access-control-allow-methods']).toBeUndefined();
    });

    // A fetch wrapper that marks every POST as JSON, whether it sends any.
    it('takes a JSON content type with no body', async () => {
      const response = await ask({
        origin: ORIGIN,
        cookie: `campus_session=${await sessionToken()}`,
        'content-type': 'application/json',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(ORIGIN);
    });

    it('lets the web app read a refused body, not just a network error', async () => {
      const app = await start();

      const response = await app.inject({
        method: 'POST',
        url: CONNECTION_CHECK_PATH,
        headers: {
          origin: ORIGIN,
          cookie: `campus_session=${await sessionToken()}`,
          'content-type': 'application/json',
        },
        payload: '{"not json',
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers).toMatchObject({
        'access-control-allow-origin': ORIGIN,
        'access-control-allow-credentials': 'true',
      });
    });
  });
});
