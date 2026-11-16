import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildWorld, type World } from '../app.js';
import {
  ORIGIN,
  routeAccounts,
  routeEnv,
  sessionToken,
} from '../http/routes.testing.js';
import { MemoryPresenceStore, type Presence } from '../infra/presence.js';
import { ONLINE_COUNT_PATH } from './online-count.js';

const COHORT = randomUUID();
const OTHER_COHORT = randomUUID();

const env = routeEnv();
const accounts = routeAccounts();

async function bearer(userId = 'root'): Promise<string> {
  return `Bearer ${await sessionToken(userId)}`;
}

function entryFor(userId: string, cohortId = COHORT): Presence {
  return {
    userId,
    connectionId: randomUUID(),
    cohortId,
    spaceKey: '_default',
    since: Date.now(),
    status: 'available',
  };
}

describe('GET /admin/online', () => {
  let world: World | undefined;
  let presence: MemoryPresenceStore;

  async function ask(
    headers: Record<string, string>,
    query = '',
    worldEnv = env,
  ) {
    world ??= await buildWorld({ env: worldEnv, accounts, presence });
    return world.app.inject({
      method: 'GET',
      url: `${ONLINE_COUNT_PATH}${query}`,
      headers,
    });
  }

  beforeEach(() => {
    presence = new MemoryPresenceStore();
    accounts.clear();
    accounts.admins.add('root');
  });

  afterEach(async () => {
    await world?.gateway.stop();
    await world?.app.close();
    world = undefined;
  });

  it('counts everybody online across the campus, each person once', async () => {
    await presence.enter(entryFor('ada'));
    await presence.enter(entryFor('ada', OTHER_COHORT));
    await presence.enter(entryFor('grace', OTHER_COHORT));

    const response = await ask({ authorization: await bearer() });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ online: 2 });
  });

  it('counts one cohort when asked', async () => {
    await presence.enter(entryFor('ada'));
    await presence.enter(entryFor('grace', OTHER_COHORT));

    const response = await ask(
      { authorization: await bearer() },
      `?cohortId=${COHORT}`,
    );

    expect(response.json()).toEqual({ online: 1 });
  });

  it('answers 0 when nobody is online', async () => {
    const response = await ask({ authorization: await bearer() });

    expect(response.json()).toEqual({ online: 0 });
  });

  it('refuses a cohortId that is not a UUID', async () => {
    const response = await ask(
      { authorization: await bearer() },
      '?cohortId=cohort-1',
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_ARGUMENT' },
    });
  });

  it('says so when presence cannot be read', async () => {
    presence.onlineUserIds = async () => {
      throw new Error('redis is down');
    };

    const response = await ask({ authorization: await bearer() });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: 'PRESENCE_UNAVAILABLE' },
    });
  });

  describe('refuses', () => {
    it('anybody who is not an admin, with 403', async () => {
      const response = await ask({ authorization: await bearer('ada') });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    });

    it('somebody not signed in, with 401', async () => {
      const response = await ask({});

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { code: 'UNAUTHORIZED', details: { reason: 'no_token' } },
      });
    });

    it('a suspended admin, with 401', async () => {
      accounts.suspended.add('root');

      const response = await ask({ authorization: await bearer() });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { details: { reason: 'account_suspended' } },
      });
    });

    it('a page world does not serve, with 403 and no CORS grant', async () => {
      const response = await ask({
        origin: 'https://elsewhere.example',
        authorization: await bearer(),
      });

      expect(response.statusCode).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('rate limit', () => {
    const limited = routeEnv({ WORLD_ONLINE_COUNTS_PER_MINUTE: '2' });
    const askLimited = (headers: Record<string, string>) =>
      ask(headers, '', limited);

    it('refuses an account past its budget, saying when to come back', async () => {
      const headers = { authorization: await bearer() };

      expect((await askLimited(headers)).statusCode).toBe(200);
      expect((await askLimited(headers)).statusCode).toBe(200);
      const refused = await askLimited(headers);

      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({
        error: { code: 'RATE_LIMITED' },
      });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(refused.headers['retry-after'])).toBeLessThanOrEqual(60);
    });

    it('counts per account, not for everybody', async () => {
      accounts.admins.add('ada');
      const root = { authorization: await bearer() };

      await askLimited(root);
      await askLimited(root);
      expect((await askLimited(root)).statusCode).toBe(429);

      expect(
        (await askLimited({ authorization: await bearer('ada') })).statusCode,
      ).toBe(200);
    });

    it('spends nothing on callers it refuses at the door', async () => {
      for (let i = 0; i < 3; i++) {
        expect(
          (await askLimited({ authorization: 'Bearer nope' })).statusCode,
        ).toBe(401);
      }

      expect(
        (await askLimited({ authorization: await bearer() })).statusCode,
      ).toBe(200);
    });

    it('lets the web app read Retry-After', async () => {
      const headers = {
        origin: ORIGIN,
        cookie: `campus_session=${await sessionToken('root')}`,
      };
      await askLimited(headers);
      await askLimited(headers);

      const refused = await askLimited(headers);

      expect(refused.statusCode).toBe(429);
      expect(refused.headers['access-control-expose-headers']).toContain(
        'retry-after',
      );
    });
  });

  describe('CORS', () => {
    it('lets the web app read the answer, with its credentials', async () => {
      const response = await ask({
        origin: ORIGIN,
        cookie: `campus_session=${await sessionToken('root')}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers).toMatchObject({
        'access-control-allow-origin': ORIGIN,
        'access-control-allow-credentials': 'true',
        vary: 'Origin',
      });
    });

    it('answers the preflight for an allowed origin only', async () => {
      await ask({ authorization: await bearer() });
      const app = (world as World).app;

      const allowed = await app.inject({
        method: 'OPTIONS',
        url: ONLINE_COUNT_PATH,
        headers: {
          origin: ORIGIN,
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization',
        },
      });
      expect(allowed.statusCode).toBe(204);
      expect(allowed.headers).toMatchObject({
        'access-control-allow-origin': ORIGIN,
        'access-control-allow-methods': 'GET',
      });
      expect(allowed.headers['access-control-allow-headers']).toContain(
        'authorization',
      );

      const other = await app.inject({
        method: 'OPTIONS',
        url: ONLINE_COUNT_PATH,
        headers: {
          origin: 'https://elsewhere.example',
          'access-control-request-method': 'GET',
        },
      });
      expect(other.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
