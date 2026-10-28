import { SessionScope, signSessionToken } from '@campus/session';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { buildWorld, type World } from '../app.js';
import { loadEnv } from '../infra/env.js';
import { MemoryPresenceStore } from '../infra/presence.js';
import { spaceIndexFrom } from '../movement/spaces.js';
import type { WorldMap } from '../movement/world-map.js';
import { seatKey } from '../seat.js';

/** The first broadcast token minted fails, as if the signing threw; the rest are real. */
const failures = vi.hoisted(() => ({ left: 1 }));
vi.mock('@campus/media', async (original) => {
  const media = await original<typeof import('@campus/media')>();
  return {
    ...media,
    mintRoomToken: async (
      ...args: Parameters<typeof media.mintRoomToken>
    ): ReturnType<typeof media.mintRoomToken> => {
      if (args[1].room.startsWith('broadcast:') && failures.left > 0) {
        failures.left -= 1;
        throw new Error('could not sign');
      }
      return media.mintRoomToken(...args);
    },
  };
});

const SECRET = 'a-world-session-secret-of-at-least-32-chars';
const ORIGIN = 'https://campus.example.com';
const COHORT = '44444444-4444-4444-8444-444444444444';

const accounts = {
  find: async (id: string) => ({
    id,
    suspended: false,
    admin: false,
    systemRole: 'user',
    sessionEpoch: 0,
    displayName: null,
    spriteKey: null,
  }),
  liveSessions: async (ids: readonly string[]) => new Set(ids),
  liveMembership: async () => true,
  liveMemberships: async (
    seats: readonly { userId: string; cohortId: string }[],
  ) => new Set(seats.map(seatKey)),
  memberships: async () => new Map(),
  spacesOn: async () => new Map(),
  onProfileChanged: async () => undefined,
  onSpacesChanged: async () => undefined,
  close: async () => undefined,
};

const map: WorldMap = {
  id: 'campus',
  version: 'v-test',
  grid: { width: 3, height: 3, spawn: { x: 0, y: 0 } },
  spaces: spaceIndexFrom({
    widthTiles: 3,
    heightTiles: 3,
    collisions: [],
    spawn: { x: 0, y: 0 },
    spaces: [],
    portals: [],
    desks: [],
  }),
};

let world: World;
let port: number;

beforeAll(async () => {
  world = await buildWorld({
    env: loadEnv({
      AUTH_SESSION_SECRET: SECRET,
      DEPLOYMENT_ENVIRONMENT: 'development',
      DATABASE_URL: 'postgres://unused',
      CORS_ORIGINS: ORIGIN,
      WORLD_HEARTBEAT_SECONDS: '1',
      LIVEKIT_URL: 'ws://127.0.0.1:9',
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'a-livekit-secret-of-at-least-32-chars',
      FF_LOG_LEVEL: 'fatal',
    } as NodeJS.ProcessEnv),
    accounts,
    presence: new MemoryPresenceStore(),
    map,
  });
  await world.app.listen({ port: 0, host: '127.0.0.1' });
  port = (world.app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await world.gateway.stop();
  await world.app.close();
});

it('tries the broadcast token again at the next heartbeat when it could not be minted', async () => {
  const userId = randomUUID();
  const { token } = await signSessionToken(
    {
      epoch: 0,
      userId,
      email: `${userId}@campus.local`,
      scope: SessionScope.FullAccess,
    },
    { secret: SECRET, ttlMinutes: 30 },
  );
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket?cohortId=${COHORT}`, {
    headers: { origin: ORIGIN, cookie: `campus_session=${token}` },
  });
  const broadcasts: unknown[] = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (message.type === 'broadcast') broadcasts.push(message.call);
  });

  await expect
    .poll(() => broadcasts, { timeout: 3_000 })
    .toEqual([
      null,
      expect.objectContaining({ room: `broadcast:${COHORT}`, canSpeak: false }),
    ]);

  const closed = new Promise((resolve) => ws.on('close', resolve));
  ws.close();
  await closed;
});
