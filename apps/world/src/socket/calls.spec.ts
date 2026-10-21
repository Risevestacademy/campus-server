import { parseSpaceRoomName, userIdOfIdentity } from '@campus/media';
import { DEFAULT_SPACE_KEY, signSessionToken } from '@campus/session';
import { SessionScope } from '@campus/session';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { buildWorld, type World } from '../app.js';
import type { WorldSpace } from '../infra/accounts.js';
import { loadEnv } from '../infra/env.js';
import { MemoryPresenceStore } from '../infra/presence.js';
import { spaceIndexFrom } from '../movement/spaces.js';
import { seatKey } from '../seat.js';
import type { WorldMap } from '../movement/world-map.js';

const SECRET = 'a-world-session-secret-of-at-least-32-chars';
const ORIGIN = 'https://campus.example.com';
const COHORT = '44444444-4444-4444-8444-444444444444';
const CORRIDOR = '55555555-5555-4555-8555-555555555555';
const LIBRARY = '66666666-6666-4666-8666-666666666666';

/** Stands in for LiveKit's server API: records who world takes out of which room. */
const removed: { room: string; identity: string }[] = [];
let livekit: Server;

function space(id: string, audioMode: string, radius = 1): WorldSpace {
  return {
    id,
    kind: 'meeting_room',
    access: 'normal',
    retiredAt: null,
    locked: false,
    grants: [],
    audioMode,
    audibleRadius: radius,
    subscribeRadius: radius,
    hysteresisFactor: 1.5,
  };
}

const spaces = new Map<string, WorldSpace>();

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
  liveMemberships: async () => new Set<string>(),
  memberships: async (seats: readonly { userId: string; cohortId: string }[]) =>
    new Map(
      seats.map((seat) => [
        seatKey(seat),
        {
          cohortId: seat.cohortId,
          role: 'professor',
          leftAt: null,
          status: null,
          accessExpiresAt: null,
          trackId: null,
        },
      ]),
    ),
  spacesOn: async () => new Map(spaces),
  onProfileChanged: async () => undefined,
  onSpacesChanged: async () => undefined,
  close: async () => undefined,
};

/** 5 × 5, spawn in the corner; the library is the top-right 2 × 2. */
const map: WorldMap = {
  id: 'campus',
  version: 'v-test',
  grid: { width: 5, height: 5, spawn: { x: 0, y: 0 } },
  spaces: spaceIndexFrom({
    widthTiles: 5,
    heightTiles: 5,
    collisions: [],
    spawn: { x: 0, y: 0 },
    spaces: [
      {
        key: 'library',
        name: 'Library',
        kind: null,
        bounds: { shape: 'rect', x: 3, y: 0, width: 2, height: 2 },
        properties: {},
      },
    ],
    portals: [],
    desks: [],
  }),
};

let world: World;
let url: string;
let stepMs: number;
let env: ReturnType<typeof loadEnv>;

beforeAll(async () => {
  livekit = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      if (request.url?.endsWith('/RemoveParticipant')) {
        removed.push(JSON.parse(body) as { room: string; identity: string });
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => livekit.listen(0, '127.0.0.1', resolve));
  const { port: livekitPort } = livekit.address() as AddressInfo;

  env = loadEnv({
    AUTH_SESSION_SECRET: SECRET,
    DEPLOYMENT_ENVIRONMENT: 'development',
    DATABASE_URL: 'postgres://unused',
    CORS_ORIGINS: ORIGIN,
    WORLD_TICK_MS: '50',
    LIVEKIT_URL: `ws://127.0.0.1:${livekitPort}`,
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'a-livekit-secret-of-at-least-32-chars',
    FF_LOG_LEVEL: 'fatal',
  } as NodeJS.ProcessEnv);
  stepMs = env.WORLD_STEP_MS;
  world = await buildWorld(
    env,
    accounts,
    undefined,
    new MemoryPresenceStore(),
    map,
  );
  await world.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = world.app.server.address() as AddressInfo;
  url = `ws://127.0.0.1:${port}/socket?cohortId=${COHORT}`;
});

afterAll(async () => {
  await world.gateway.stop();
  await world.app.close();
  await new Promise((resolve) => livekit.close(resolve));
});

beforeEach(async () => {
  removed.length = 0;
  spaces.clear();
  spaces.set(DEFAULT_SPACE_KEY, space(CORRIDOR, 'proximity'));
  spaces.set('library', space(LIBRARY, 'boundary'));
  await world.gateway.spacesChanged();
});

async function arrive() {
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
  const ws = new WebSocket(url, {
    headers: { origin: ORIGIN, cookie: `campus_session=${token}` },
  });
  const messages: Record<string, unknown>[] = [];
  ws.on('message', (raw) =>
    messages.push(JSON.parse(raw.toString()) as Record<string, unknown>),
  );
  const conn = { userId, ws, messages };
  await waitFor(conn, (m) => m.type === 'snapshot');
  return conn;
}

type Conn = Awaited<ReturnType<typeof arrive>>;

async function waitFor(
  conn: { messages: Record<string, unknown>[] },
  match: (message: Record<string, unknown>) => boolean,
  from = 0,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const found = conn.messages.slice(from).find(match);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('no matching message arrived');
}

async function step(conn: Conn, direction: string, seq: number) {
  conn.ws.send(JSON.stringify({ type: 'move', direction, seq }));
  await waitFor(conn, (m) => m.type === 'moveResult' && m.seq === seq);
  await new Promise((resolve) => setTimeout(resolve, stepMs));
}

async function leave(...conns: Conn[]) {
  for (const conn of conns) {
    const closed = new Promise((resolve) => conn.ws.on('close', resolve));
    conn.ws.close();
    await closed;
  }
}

/** Removals of this person: another test's closing socket can land late. */
const removedFor = (conn: Conn) =>
  removed
    .filter(({ identity }) => userIdOfIdentity(identity) === conn.userId)
    .map(({ room }) => room);

const calls = (conn: Conn) =>
  conn.messages
    .filter((m) => m.type === 'call')
    .map((m) => m.call as Record<string, unknown> | null);

const nearbyLists = (conn: Conn) =>
  conn.messages
    .filter((m) => m.type === 'nearby')
    .map((m) => m.userIds as string[]);

describe('the call for the space you stand in', () => {
  it('hands an arrival the call for the corridor, heard by distance', async () => {
    const ada = await arrive();

    const message = await waitFor(ada, (m) => m.type === 'call');
    const call = message.call as Record<string, unknown>;
    expect(call).toMatchObject({
      hearing: 'proximity',
      audibleRadius: 1,
      subscribeRadius: 1,
    });
    expect(parseSpaceRoomName(call.room as string)).toEqual({
      cohortId: COHORT,
      spaceId: CORRIDOR,
    });
    expect(call.token).toEqual(expect.any(String));
    await leave(ada);
  });

  it('moves you to the library’s call as you step in, and takes you out of the corridor’s', async () => {
    const ada = await arrive();
    await waitFor(ada, (m) => m.type === 'call');

    for (const seq of [1, 2, 3]) await step(ada, 'right', seq);
    await waitFor(
      ada,
      (m) => m.type === 'call',
      1 + ada.messages.findIndex((m) => m.type === 'call'),
    );

    const [corridor, library] = calls(ada);
    expect(parseSpaceRoomName(library?.room as string)).toEqual({
      cohortId: COHORT,
      spaceId: LIBRARY,
    });
    expect(library?.hearing).toBe('room');
    await expect.poll(() => removedFor(ada)).toEqual([corridor?.room]);
    await leave(ada);
  });

  it('says there is no call in a space the database has no row for', async () => {
    spaces.delete(DEFAULT_SPACE_KEY);
    await world.gateway.spacesChanged();

    const ada = await arrive();

    await expect(waitFor(ada, (m) => m.type === 'call')).resolves.toEqual({
      type: 'call',
      call: null,
    });
    await leave(ada);
  });

  it('takes you out of the call when your socket closes', async () => {
    const ada = await arrive();
    const message = await waitFor(ada, (m) => m.type === 'call');

    await leave(ada);

    await expect
      .poll(() => removedFor(ada))
      .toEqual([(message.call as { room: string }).room]);
  });
});

describe('who is near enough to hear', () => {
  it('names the people within the radius, keeps them a little past it, and drops them beyond', async () => {
    const ada = await arrive();
    const grace = await arrive();

    await expect.poll(() => nearbyLists(ada).at(-1)).toEqual([grace.userId]);
    await expect.poll(() => nearbyLists(grace).at(-1)).toEqual([ada.userId]);

    // One step apart: inside the radius. Two: past the radius but inside
    // its hysteresis, so still heard. Three: gone.
    await step(grace, 'down', 1);
    await step(grace, 'right', 2);
    expect(nearbyLists(ada).at(-1)).toEqual([grace.userId]);
    await step(grace, 'right', 3);
    await expect.poll(() => nearbyLists(ada).at(-1)).toEqual([]);
    await expect.poll(() => nearbyLists(grace).at(-1)).toEqual([]);

    await leave(ada, grace);
  });

  it('names nobody in a room-wide space, where everybody is heard', async () => {
    const ada = await arrive();
    for (const seq of [1, 2, 3]) await step(ada, 'right', seq);
    const grace = await arrive();
    for (const seq of [1, 2, 3]) await step(grace, 'right', seq);

    expect(nearbyLists(ada).flat()).not.toContain(grace.userId);
    await leave(ada, grace);
  });

  it('drops somebody who leaves', async () => {
    const ada = await arrive();
    const grace = await arrive();
    await expect.poll(() => nearbyLists(ada).at(-1)).toEqual([grace.userId]);

    await leave(grace);

    await expect.poll(() => nearbyLists(ada).at(-1)).toEqual([]);
    await leave(ada);
  });
});

describe('keeping calls current', () => {
  it('tells somebody walking out of a proximity space that nobody is near any more', async () => {
    // Wide enough that grace is still in range at the library's door.
    spaces.set(DEFAULT_SPACE_KEY, space(CORRIDOR, 'proximity', 3));
    await world.gateway.spacesChanged();
    const ada = await arrive();
    const grace = await arrive();
    await expect.poll(() => nearbyLists(ada).at(-1)).toEqual([grace.userId]);

    await step(ada, 'right', 1);
    await step(ada, 'right', 2);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(nearbyLists(ada).at(-1)).toEqual([grace.userId]);
    await step(ada, 'right', 3);

    await expect.poll(() => nearbyLists(ada).at(-1)).toEqual([]);
    await leave(ada, grace);
  });

  it('hands out a call without a step once the space has a row', async () => {
    spaces.delete(DEFAULT_SPACE_KEY);
    await world.gateway.spacesChanged();
    const ada = await arrive();
    await waitFor(ada, (m) => m.type === 'call');
    expect(calls(ada)).toEqual([null]);

    spaces.set(DEFAULT_SPACE_KEY, space(CORRIDOR, 'proximity'));
    await world.gateway.spacesChanged();

    await expect
      .poll(() => calls(ada).at(-1)?.room)
      .toEqual(expect.stringContaining(CORRIDOR));
    await leave(ada);
  });

  it('hands out a new call when the space’s hearing changes', async () => {
    const ada = await arrive();
    await waitFor(ada, (m) => m.type === 'call');

    spaces.set(DEFAULT_SPACE_KEY, space(CORRIDOR, 'boundary'));
    await world.gateway.spacesChanged();

    await expect
      .poll(() => calls(ada).map((call) => call?.hearing))
      .toEqual(['proximity', 'room']);
    await leave(ada);
  });

  it('leaves people in their calls when world shuts down', async () => {
    const own = await buildWorld(
      env,
      accounts,
      undefined,
      new MemoryPresenceStore(),
      map,
    );
    await own.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = own.app.server.address() as AddressInfo;
    const saved = url;
    url = `ws://127.0.0.1:${port}/socket?cohortId=${COHORT}`;
    try {
      const ada = await arrive();
      await waitFor(ada, (m) => m.type === 'call');
      const closed = new Promise((resolve) => ada.ws.on('close', resolve));

      await own.gateway.stop();
      await closed;
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(removedFor(ada)).toEqual([]);
    } finally {
      url = saved;
      await own.app.close();
    }
  });
});
