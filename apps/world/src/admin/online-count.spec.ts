import { SessionScope, signSessionToken } from '@campus/session';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildWorld, type World } from '../app.js';
import type { Account } from '../infra/accounts.js';
import { loadEnv } from '../infra/env.js';
import { MemoryPresenceStore, type Presence } from '../infra/presence.js';
import { ONLINE_COUNT_PATH } from './online-count.js';

const SECRET = 'a-world-session-secret-of-at-least-32-chars';
const ORIGIN = 'http://localhost:3002';
const COHORT = randomUUID();
const OTHER_COHORT = randomUUID();

const env = loadEnv({
  AUTH_SESSION_SECRET: SECRET,
  DEPLOYMENT_ENVIRONMENT: 'development',
  DATABASE_URL: 'postgres://unused',
  CORS_ORIGINS: ORIGIN,
  FF_LOG_LEVEL: 'fatal',
} as NodeJS.ProcessEnv);

const admins = new Set(['root']);
const accounts = {
  find: async (id: string): Promise<Account | null> => ({
    id,
    suspended: id === 'banned',
    sessionEpoch: 0,
    admin: admins.has(id),
    systemRole: admins.has(id) ? 'admin' : 'user',
    displayName: null,
    spriteKey: null,
  }),
  liveSessions: async () => new Set<string>(),
  liveMembership: async () => false,
  liveMemberships: async () => new Set<string>(),
  memberships: async () => new Map(),
  spacesOn: async () => new Map(),
  onProfileChanged: async () => undefined,
  onSpacesChanged: async () => undefined,
  close: async () => undefined,
};

async function bearer(userId = 'root'): Promise<string> {
  const { token } = await signSessionToken(
    {
      epoch: 0,
      userId,
      email: `${userId}@campus.local`,
      scope: SessionScope.FullAccess,
    },
    { secret: SECRET, ttlMinutes: 15 },
  );
  return `Bearer ${token}`;
}

function present(userId: string, cohortId = COHORT): Presence {
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

  async function ask(headers: Record<string, string>, query = '') {
    world ??= await buildWorld(env, accounts, undefined, presence);
    return world.app.inject({
      method: 'GET',
      url: `${ONLINE_COUNT_PATH}${query}`,
      headers,
    });
  }

  beforeEach(() => {
    presence = new MemoryPresenceStore();
  });

  afterEach(async () => {
    await world?.gateway.stop();
    await world?.app.close();
    world = undefined;
  });

  it('counts everybody online across the campus, each person once', async () => {
    await presence.enter(present('ada'));
    await presence.enter(present('ada', OTHER_COHORT));
    await presence.enter(present('grace', OTHER_COHORT));

    const response = await ask({ authorization: await bearer() });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ online: 2 });
  });

  it('counts one cohort when asked', async () => {
    await presence.enter(present('ada'));
    await presence.enter(present('grace', OTHER_COHORT));

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

    it('a suspended account, with 401', async () => {
      admins.add('banned');
      try {
        const response = await ask({ authorization: await bearer('banned') });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({
          error: { details: { reason: 'account_suspended' } },
        });
      } finally {
        admins.delete('banned');
      }
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

  describe('CORS', () => {
    it('lets the web app read the answer, with its credentials', async () => {
      const response = await ask({
        origin: ORIGIN,
        cookie: `campus_session=${(await bearer()).slice('Bearer '.length)}`,
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
