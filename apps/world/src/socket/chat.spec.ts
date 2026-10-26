import { DEFAULT_SPACE_KEY, signSessionToken } from '@campus/session';
import { SessionScope } from '@campus/session';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { buildWorld, type World } from '../app.js';
import type { WorldSpace } from '../infra/accounts.js';
import { loadEnv } from '../infra/env.js';
import { MemoryPresenceStore } from '../infra/presence.js';
import { spaceIndexFrom } from '../movement/spaces.js';
import type { WorldMap } from '../movement/world-map.js';
import { seatKey } from '../seat.js';

const SECRET = 'a-world-session-secret-of-at-least-32-chars';
const ORIGIN = 'https://campus.example.com';
const COHORT = '44444444-4444-4444-8444-444444444444';
const OTHER_COHORT = '77777777-7777-4777-8777-777777777777';

function space(audioMode: string, radius = 1): WorldSpace {
  return {
    id: randomUUID(),
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
  liveMemberships: async (
    seats: readonly { userId: string; cohortId: string }[],
  ) => new Set(seats.map(seatKey)),
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
          mentorshipGroupId: null,
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
let port: number;
let stepMs: number;

/** No LiveKit: chat must not need calls. */
beforeAll(async () => {
  const env = loadEnv({
    AUTH_SESSION_SECRET: SECRET,
    DEPLOYMENT_ENVIRONMENT: 'development',
    DATABASE_URL: 'postgres://unused',
    CORS_ORIGINS: ORIGIN,
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
  port = (world.app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await world.gateway.stop();
  await world.app.close();
});

beforeEach(async () => {
  spaces.clear();
  spaces.set(DEFAULT_SPACE_KEY, space('proximity', 2));
  spaces.set('library', space('boundary'));
  await world.gateway.spacesChanged();
});

async function arrive(cohortId = COHORT) {
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
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/socket?cohortId=${cohortId}`,
    { headers: { origin: ORIGIN, cookie: `campus_session=${token}` } },
  );
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
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const found = conn.messages.find(match);
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

/** Three steps right: the last one is into the library. */
async function intoLibrary(conn: Conn) {
  for (const seq of [1, 2, 3]) await step(conn, 'right', seq);
}

async function leave(...conns: Conn[]) {
  for (const conn of conns) {
    const closed = new Promise((resolve) => conn.ws.on('close', resolve));
    conn.ws.close();
    await closed;
  }
}

const say = (conn: Conn, text: string) =>
  conn.ws.send(JSON.stringify({ type: 'say', text }));

const heard = (conn: Conn) =>
  conn.messages.filter((m) => m.type === 'said').map((m) => m.text as string);

/** Long enough that anything world was going to send has arrived. */
const quiet = () => new Promise((resolve) => setTimeout(resolve, 150));

describe('saying something', () => {
  it('reaches the speaker and whoever is within the radius in a proximity space', async () => {
    const ada = await arrive();
    const grace = await arrive();
    const linus = await arrive();
    // Three tiles away: past the corridor's radius of two.
    for (const seq of [1, 2, 3]) await step(linus, 'right', seq);
    await step(linus, 'down', 4);
    await step(linus, 'down', 5);

    say(ada, '  hello  ');

    const said = await waitFor(grace, (m) => m.type === 'said');
    expect(said).toEqual({
      type: 'said',
      id: expect.any(String),
      userId: ada.userId,
      spaceKey: DEFAULT_SPACE_KEY,
      text: 'hello',
      at: expect.any(String),
    });
    await expect(waitFor(ada, (m) => m.type === 'said')).resolves.toEqual(said);
    await quiet();
    expect(heard(linus)).toEqual([]);
    await leave(ada, grace, linus);
  });

  it('reaches everybody in a whole-room space, and nobody outside it', async () => {
    const ada = await arrive();
    const grace = await arrive();
    const outside = await arrive();
    await intoLibrary(ada);
    await intoLibrary(grace);
    await step(grace, 'down', 4);
    await step(outside, 'right', 1);
    await step(outside, 'right', 2);

    say(ada, 'meeting starts');

    await expect(
      waitFor(grace, (m) => m.type === 'said'),
    ).resolves.toMatchObject({ text: 'meeting starts', spaceKey: 'library' });
    await quiet();
    expect(heard(outside)).toEqual([]);
    await leave(ada, grace, outside);
  });

  it('never reaches another cohort', async () => {
    const ada = await arrive();
    const elsewhere = await arrive(OTHER_COHORT);

    say(ada, 'hello');

    await waitFor(ada, (m) => m.type === 'said');
    await quiet();
    expect(heard(elsewhere)).toEqual([]);
    await leave(ada, elsewhere);
  });

  it('hears by distance, at the default radius, in a space with no row yet', async () => {
    spaces.delete(DEFAULT_SPACE_KEY);
    await world.gateway.spacesChanged();
    const ada = await arrive();
    const grace = await arrive();
    for (const seq of [1, 2]) await step(grace, 'right', seq);

    say(ada, 'still here');

    await expect(
      waitFor(grace, (m) => m.type === 'said'),
    ).resolves.toMatchObject({ text: 'still here' });
    await leave(ada, grace);
  });

  it('refuses an empty line, or one too long, leaving the socket open', async () => {
    const ada = await arrive();

    say(ada, '   ');
    say(ada, 'x'.repeat(501));

    await expect
      .poll(() => ada.messages.filter((m) => m.type === 'error'))
      .toEqual([
        expect.objectContaining({ code: 'BAD_MESSAGE' }),
        expect.objectContaining({ code: 'BAD_MESSAGE' }),
      ]);
    say(ada, 'x'.repeat(500));
    await waitFor(ada, (m) => m.type === 'said');
    await leave(ada);
  });

  it('refuses a sixth line in a burst, then lets one through a second later', async () => {
    const ada = await arrive();

    for (let i = 1; i <= 6; i += 1) say(ada, `line ${i}`);

    await expect(
      waitFor(ada, (m) => m.type === 'error'),
    ).resolves.toMatchObject({
      code: 'NOT_ALLOWED',
      message: 'saying too much too fast',
    });
    expect(heard(ada)).toEqual([
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    say(ada, 'line 7');
    await expect.poll(() => heard(ada).at(-1)).toBe('line 7');
    await leave(ada);
  });
});
