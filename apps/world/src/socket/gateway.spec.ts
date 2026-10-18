import { signSessionToken, SessionScope } from '@campus/session';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Redis } from 'ioredis';
import WebSocket from 'ws';

import { buildWorld, type World } from '../app.js';
import { oneAtATime } from './gateway.js';
import { loadEnv } from '../infra/env.js';
import type { PositionToSave } from '../infra/positions.js';
import { tileIndex } from '../movement/grid.js';
import { spaceIndexFrom } from '../movement/spaces.js';
import type { WorldMap } from '../movement/world-map.js';
import {
  DISPLACED_CHANNEL,
  MemoryPresenceStore,
  type Displacement,
  type Presence,
} from '../infra/presence.js';

const SECRET = 'a-world-session-secret-of-at-least-32-chars';
const ORIGIN = 'https://campus.example.com';
const COHORT = 'cohort-1';

/** How the fake store keys a position: by account and cohort. */
const positionKey = (userId: string, cohortId = COHORT) =>
  `${userId}:${cohortId}`;

/** Answers for the database, so these tests need none. */
const accounts = {
  suspended: new Set<string>(),
  gone: new Set<string>(),
  /** Logins signed out, revoked or no longer refreshed. Every other one is live. */
  endedSessions: new Set<string>(),
  /** Session epochs that have moved on from zero, where every account starts. */
  epochs: new Map<string, number>(),
  /** `userId:cohortId` pairs with no live membership. Everything else has one. */
  notMembers: new Set<string>(),
  /** When each guest's visit runs out: `userId:cohortId` to the end date. */
  visitEnds: new Map<string, Date>(),
  admins: new Set<string>(),
  /** Profiles with a name or sprite set. Everybody else has neither. */
  looks: new Map<string, { displayName: string; spriteKey: string }>(),
  find: async (userId: string) =>
    accounts.gone.has(userId)
      ? null
      : {
          id: userId,
          suspended: accounts.suspended.has(userId),
          admin: accounts.admins.has(userId),
          sessionEpoch: accounts.epochs.get(userId) ?? 0,
          displayName: accounts.looks.get(userId)?.displayName ?? null,
          spriteKey: accounts.looks.get(userId)?.spriteKey ?? null,
        },
  liveSessions: async (ids: readonly string[]): Promise<Set<string>> =>
    new Set(ids.filter((id) => !accounts.endedSessions.has(id))),
  /** As the database's own question: is this membership live at `now`? */
  liveMembership: async (
    userId: string,
    cohortId: string,
    now: Date,
  ): Promise<boolean> => {
    const key = `${userId}:${cohortId}`;
    if (accounts.notMembers.has(key)) return false;
    const ends = accounts.visitEnds.get(key);
    return ends === undefined || ends > now;
  },
  /** Who campus-api tells, through Postgres, when a profile changes. */
  profileListeners: [] as ((userId: string) => void)[],
  onProfileChanged: async (listener: (userId: string) => void) => {
    accounts.profileListeners.push(listener);
  },
  /** campus-api saving a new sprite or name: the row, then the notification. */
  changeLooks: (
    userId: string,
    looks: { displayName: string; spriteKey: string },
  ) => {
    accounts.looks.set(userId, looks);
    for (const listener of accounts.profileListeners) listener(userId);
  },
  close: async () => undefined,
};

/** Stands in for Redis: where each person last stood, kept between visits. */
const store = {
  positions: new Map<string, { x: number; y: number; facing: string }>(),
  failLoad: false,
  failSave: false,
  loads: 0,
  /**
   * Loads a test holds open, by cohort, so a second connection for the same
   * account can take its place while one waits on its saved position.
   */
  heldLoads: new Map<string, Promise<void>>(),
  load: async (userId: string, cohortId: string) => {
    store.loads += 1;
    const held = store.heldLoads.get(cohortId);
    if (held) await held;
    if (store.failLoad) throw new Error('redis is down');
    return store.positions.get(positionKey(userId, cohortId)) as
      | { x: number; y: number; facing: 'up' | 'down' | 'left' | 'right' }
      | undefined;
  },
  save: async (entries: readonly PositionToSave[]) => {
    if (store.failSave) throw new Error('redis is down');
    for (const { userId, cohortId, x, y, facing } of entries) {
      store.positions.set(positionKey(userId, cohortId), { x, y, facing });
    }
  },
  forget: async (userId: string, cohortId: string) => {
    store.positions.delete(positionKey(userId, cohortId));
  },
  ready: async () => true,
  close: async () => undefined,
};

/** Stands in for presence in Redis, and for the other instances behind it. */
/** One presence entry per account and cohort, as the real stores keep them. */
const presenceKeyOf = (userId: string, cohortId = COHORT) =>
  `${userId}:${cohortId}`;

const presence = {
  instanceId: 'this-instance',
  entries: new Map<string, Presence>(),
  /** Connections whose account a newer connection on another instance holds. */
  heldElsewhere: new Set<string>(),
  failing: false,
  listeners: [] as ((displaced: Displacement) => void)[],
  /** Set to have the next entry find a newer connection holding the place. */
  newerElsewhere: false,
  enter: async (entry: Presence) => {
    if (presence.failing) throw new Error('redis is down');
    if (presence.newerElsewhere) {
      presence.newerElsewhere = false;
      return false;
    }
    presence.entries.set(presenceKeyOf(entry.userId, entry.cohortId), entry);
    return true;
  },
  /**
   * Writes made the moment somebody crosses into another space, told apart
   * from the regular renewal by who called: the gateway's presenceNow. So a
   * test can count crossings without racing the renewal's timer.
   */
  crossings: [] as Presence[],
  renew: async (entries: readonly Presence[]) => {
    if (new Error().stack?.includes('presenceNow')) {
      presence.crossings.push(...entries);
    }
    if (presence.failing) throw new Error('redis is down');
    const displaced: Displacement[] = [];
    for (const entry of entries) {
      if (presence.heldElsewhere.has(entry.connectionId)) {
        displaced.push(entry);
      } else {
        presence.entries.set(
          presenceKeyOf(entry.userId, entry.cohortId),
          entry,
        );
      }
    }
    return displaced;
  },
  leave: async (entries: readonly Presence[]) => {
    for (const { userId, cohortId, connectionId } of entries) {
      const key = presenceKeyOf(userId, cohortId);
      if (presence.entries.get(key)?.connectionId === connectionId) {
        presence.entries.delete(key);
      }
    }
  },
  online: async () => [],
  onDisplaced: (listener: (displaced: Displacement) => void) => {
    presence.listeners.push(listener);
  },
  close: async () => undefined,
  /** What another instance says once the account enters the campus there. */
  displace: (displaced: Displacement) => {
    for (const listener of presence.listeners) listener(displaced);
  },
};

const env = loadEnv({
  AUTH_SESSION_SECRET: SECRET,
  DEPLOYMENT_ENVIRONMENT: 'development',
  DATABASE_URL: 'postgres://unused',
  CORS_ORIGINS: `${ORIGIN},http://localhost:3000`,
  WORLD_HEARTBEAT_SECONDS: '1',
  WORLD_MAX_MESSAGE_BYTES: '256',
  // Long enough that steps sent together reliably land in one tick.
  WORLD_TICK_MS: '200',
  // The shortest allowed, so a periodic save lands within a test.
  WORLD_POSITION_SAVE_SECONDS: '1',
  // The shortest allowed, so presence is renewed every second.
  WORLD_PRESENCE_TTL_SECONDS: '3',
  FF_LOG_LEVEL: 'fatal',
} as NodeJS.ProcessEnv);

/**
 * Small, with spawn in a corner, so an edge is one step away, and one wall
 * two steps below the spawn. One drawn space, the library, in the top-right
 * corner (x 3 to 4, y 0 to 1): three steps right of the spawn.
 */
const WALL = { x: 0, y: 2 };
const walls = new Uint8Array(5 * 5);
walls[tileIndex({ width: 5 }, WALL)] = 1;
const map: WorldMap = {
  id: 'campus',
  version: 'v-test',
  grid: { width: 5, height: 5, spawn: { x: 0, y: 0 }, walls },
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

async function token(
  scope: SessionScope = SessionScope.FullAccess,
  secret = SECRET,
  userId = 'user-1',
  epoch = 0,
): Promise<string> {
  const { token } = await signSessionToken(
    { epoch, userId, email: `${userId}@campus.local`, scope },
    { secret, ttlMinutes: 30 },
  );
  return token;
}

/**
 * Opens a socket and collects what the server says, until it closes or
 * settles. Pass '' as the cohort to leave the parameter off entirely.
 */
function connect(headers: Record<string, string>, cohortId = COHORT) {
  const target =
    cohortId === '' ? url : `${url}?cohortId=${encodeURIComponent(cohortId)}`;
  const ws = new WebSocket(target, { headers });
  const messages: Record<string, unknown>[] = [];

  const settled = new Promise<{ closeCode?: number; closeReason?: string }>(
    (resolve) => {
      ws.on('message', (raw) => {
        messages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
      });
      ws.on('close', (code, reason) =>
        resolve({ closeCode: code, closeReason: reason.toString() }),
      );
      ws.on('error', () => undefined);
    },
  );

  const first = new Promise<Record<string, unknown>>((resolve) => {
    ws.on('message', (raw) =>
      resolve(JSON.parse(raw.toString()) as Record<string, unknown>),
    );
  });

  return { ws, messages, settled, first };
}

/** Resolves with the first message that matches, including ones already received. */
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

/** Where everybody in a snapshot stands, leaving out what to draw for them. */
function positionsIn(snapshot: Record<string, unknown>) {
  return (snapshot.players as Record<string, unknown>[]).map(
    ({ displayName: _name, spriteKey: _sprite, ...player }) => player,
  );
}

beforeEach(() => {
  // A test that moves the clock must not leave it moved: every deadline
  // after it would be read against the wrong time.
  vi.useRealTimers();
  accounts.suspended.clear();
  accounts.gone.clear();
  accounts.endedSessions.clear();
  accounts.epochs.clear();
  accounts.notMembers.clear();
  accounts.visitEnds.clear();
  accounts.admins.clear();
  accounts.looks.clear();
  store.positions.clear();
  store.failLoad = false;
  store.failSave = false;
  store.loads = 0;
  store.heldLoads.clear();
  presence.entries.clear();
  presence.heldElsewhere.clear();
  presence.failing = false;
});

/**
 * Tests close their sockets, but a close is a handshake and finishes after
 * the test does. Without waiting for it, the next test that counts
 * connections also counts the last test's leftovers — which is how the suite
 * went flaky on a slow run. Throws rather than carrying on, so a test that
 * forgets to close its socket is found here instead of three tests later.
 */
afterEach(async () => {
  const deadline = Date.now() + 5_000;
  while (world.gateway.connections.size > 0) {
    if (Date.now() > deadline) {
      throw new Error(
        `test left ${world.gateway.connections.size} socket(s) open`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});

beforeAll(async () => {
  world = await buildWorld(env, accounts, store, presence, map);
  await world.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = world.app.server.address() as AddressInfo;
  url = `ws://127.0.0.1:${port}/socket`;
});

afterAll(async () => {
  await world.gateway.stop();
  await world.app.close();
});

describe('socket upgrade', () => {
  it('welcomes a full-access session from an allowed origin', async () => {
    const { ws, first } = connect({
      origin: ORIGIN,
      cookie: `campus_session=${await token()}`,
    });

    await expect(first).resolves.toMatchObject({
      type: 'welcome',
      userId: 'user-1',
      heartbeatSeconds: 1,
      stepMs: 100,
      tickMs: 200,
    });
    ws.close();
  });

  /**
   * The upgrade is not subject to CORS, so this check is the only thing
   * stopping any page the user has open from holding a socket with their
   * cookie attached.
   */
  it('refuses a cookie from an origin it does not serve', async () => {
    const { first, settled } = connect({
      origin: 'https://evil.example',
      cookie: `campus_session=${await token()}`,
    });

    await expect(first).resolves.toMatchObject({
      type: 'error',
      code: 'UNAUTHORIZED',
      message: 'origin_not_allowed',
    });
    await expect(settled).resolves.toMatchObject({ closeCode: 1008 });
  });

  it('refuses a socket that names no cohort', async () => {
    const { first, settled } = connect(
      { origin: ORIGIN, cookie: `campus_session=${await token()}` },
      '',
    );

    await expect(first).resolves.toMatchObject({
      type: 'error',
      code: 'UNAUTHORIZED',
      message: 'no_cohort',
    });
    await expect(settled).resolves.toMatchObject({ closeCode: 1008 });
  });

  it('refuses a cohort the account has no live membership in', async () => {
    accounts.notMembers.add('user-1:cohort-elsewhere');

    const { first, settled } = connect(
      { origin: ORIGIN, cookie: `campus_session=${await token()}` },
      'cohort-elsewhere',
    );

    await expect(first).resolves.toMatchObject({
      type: 'error',
      code: 'UNAUTHORIZED',
      message: 'not_a_member',
    });
    await expect(settled).resolves.toMatchObject({ closeCode: 1008 });
  });

  /** Campus-api's sign-in gate admits an admin on their role alone. */
  it('lets an admin into a cohort they hold no membership in', async () => {
    accounts.admins.add('user-1');
    accounts.notMembers.add('user-1:cohort-elsewhere');

    const { ws, first } = connect(
      { origin: ORIGIN, cookie: `campus_session=${await token()}` },
      'cohort-elsewhere',
    );

    await expect(first).resolves.toMatchObject({
      type: 'welcome',
      userId: 'user-1',
    });
    ws.close();
  });

  it('refuses a cookie sent with no origin at all', async () => {
    const { first } = connect({ cookie: `campus_session=${await token()}` });

    await expect(first).resolves.toMatchObject({
      message: 'origin_not_allowed',
    });
  });

  /** Not a browser, so no cookie to hijack — a bearer token stands alone. */
  it('accepts a bearer token with no origin', async () => {
    const { ws, first } = connect({ authorization: `Bearer ${await token()}` });

    await expect(first).resolves.toMatchObject({ type: 'welcome' });
    ws.close();
  });

  it('refuses a session with no token', async () => {
    const { first } = connect({ origin: ORIGIN });

    await expect(first).resolves.toMatchObject({ message: 'no_token' });
  });

  it('refuses a token this deployment did not sign', async () => {
    const foreign = await token(
      SessionScope.FullAccess,
      'a-different-secret-of-at-least-32-characters',
    );
    const { first } = connect({
      origin: ORIGIN,
      cookie: `campus_session=${foreign}`,
    });

    await expect(first).resolves.toMatchObject({ message: 'token_not_usable' });
  });

  it('refuses a session whose account has been suspended', async () => {
    accounts.suspended.add('user-1');
    const { first } = connect({
      origin: ORIGIN,
      cookie: `campus_session=${await token()}`,
    });

    await expect(first).resolves.toMatchObject({
      message: 'account_suspended',
    });
  });

  it('refuses a session whose account no longer exists', async () => {
    accounts.gone.add('user-1');
    const { first } = connect({
      origin: ORIGIN,
      cookie: `campus_session=${await token()}`,
    });

    await expect(first).resolves.toMatchObject({ message: 'account_gone' });
  });

  /** Half-onboarded has no place in the world yet. */
  it('refuses a provisional session', async () => {
    const provisional = await token(SessionScope.Provisional);
    const { first } = connect({
      origin: ORIGIN,
      cookie: `campus_session=${provisional}`,
    });

    await expect(first).resolves.toMatchObject({ message: 'wrong_scope' });
  });
});

describe('sockets that go wrong', () => {
  /**
   * A client that sends the moment it is open is racing authentication: the
   * message listener goes on after the await, and an event with no listener
   * is simply gone.
   */
  it('does not lose a frame sent the instant the socket opens', async () => {
    const ws = new WebSocket(`${url}?cohortId=${COHORT}`, {
      headers: { origin: ORIGIN, cookie: `campus_session=${await token()}` },
    });
    const replies: Record<string, unknown>[] = [];
    ws.on('message', (raw) =>
      replies.push(JSON.parse(raw.toString()) as Record<string, unknown>),
    );
    ws.on('open', () => {
      for (let seq = 0; seq < 5; seq++) {
        ws.send(JSON.stringify({ type: 'move', direction: 'right', seq }));
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 500));
    ws.close();

    // Every frame answered, and in the order it was sent — whatever each
    // one's outcome, since five at once is past the walking speed.
    expect(
      replies.filter((r) => r.type === 'moveResult').map((r) => r.seq),
    ).toEqual([0, 1, 2, 3, 4]);
  });

  /**
   * Authentication is asynchronous, so a client can be gone before it
   * finishes. If the registry learns about that connection afterwards,
   * nothing ever removes it.
   */
  it('registers nothing for a client that dies mid-handshake', async () => {
    const dying = Array.from({ length: 20 }, async () => {
      const ws = new WebSocket(url, {
        headers: { origin: ORIGIN, cookie: `campus_session=${await token()}` },
      });
      ws.on('error', () => undefined);
      // Kill the TCP socket the instant the handshake completes, which is
      // the window where authentication is still in flight.
      ws.on('upgrade', (res) => res.socket.destroy());
      return new Promise((resolve) => ws.on('close', resolve));
    });
    await Promise.all(dying);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(world.gateway.connections.size).toBe(0);
  });

  it('closes a frame larger than the limit', async () => {
    const conn = connect({
      origin: ORIGIN,
      cookie: `campus_session=${await token()}`,
    });
    await conn.first;

    conn.ws.send(JSON.stringify({ type: 'ping', padding: 'x'.repeat(5_000) }));

    await expect(conn.settled).resolves.toMatchObject({ closeCode: 1009 });
  });

  /** A session that has run out must not survive on an already-open socket. */
  /**
   * The point of re-checking: a ban has to reach sockets that are already
   * open, not just the next upgrade attempt.
   */
  it('closes an open socket when the account is suspended', async () => {
    const conn = connect({
      origin: ORIGIN,
      cookie: `campus_session=${await token()}`,
    });
    await conn.first;
    expect(world.gateway.connections.size).toBe(1);

    accounts.suspended.add('user-1');

    await expect(conn.settled).resolves.toMatchObject({ closeCode: 1008 });
    expect(world.gateway.connections.size).toBe(0);
  }, 15_000);

  describe('once the account sessions are revoked', () => {
    const REVOKED = 'user-9';
    const open = async (epoch: number) => {
      const conn = connect({
        origin: ORIGIN,
        cookie: `campus_session=${await token(
          SessionScope.FullAccess,
          SECRET,
          REVOKED,
          epoch,
        )}`,
      });
      await conn.first;
      return conn;
    };

    /** A token from before the revoke, however long it still has to run. */
    it('refuses an upgrade with a token signed before it', async () => {
      accounts.epochs.set(REVOKED, 1);
      const { first, settled } = connect({
        origin: ORIGIN,
        cookie: `campus_session=${await token(
          SessionScope.FullAccess,
          SECRET,
          REVOKED,
          0,
        )}`,
      });

      await expect(first).resolves.toMatchObject({
        message: 'session_revoked',
      });
      await expect(settled).resolves.toMatchObject({ closeCode: 1008 });
    });

    it('closes a socket that was already open', async () => {
      const conn = await open(0);

      accounts.epochs.set(REVOKED, 1);

      await expect(conn.settled).resolves.toMatchObject({
        closeCode: 1008,
        closeReason: 'session_revoked',
      });
      expect(world.gateway.connections.size).toBe(0);
    }, 15_000);

    // Revoking ends sessions, not the account: signing back in may resume
    // where they stood, unlike a suspension, which forgets the position.
    it('keeps the position for signing back in', async () => {
      const conn = await open(0);

      accounts.epochs.set(REVOKED, 1);
      await conn.settled;

      await expect
        .poll(() => world.gateway.players.isRemembered(REVOKED, COHORT))
        .toBe(true);
    }, 15_000);

    // An account holds one socket. Signing in again after the revoke opens
    // a new one, which takes the old one's place; the sweep then finds a
    // socket on the current epoch and leaves it alone.
    it('leaves alone a socket opened after it, which replaced the old one', async () => {
      const before = await open(0);
      accounts.epochs.set(REVOKED, 1);
      const after = await open(1);

      await expect(before.settled).resolves.toMatchObject({
        closeCode: 4000,
        closeReason: 'entered_elsewhere',
      });
      // Through at least one more sweep, and still here.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(after.ws.readyState).toBe(after.ws.OPEN);

      after.ws.close();
      await after.settled;
    }, 20_000);
  });

  /** A database that is down must not throw the campus off. */
  it('leaves sockets alone when the account check fails', async () => {
    const conn = connect({
      origin: ORIGIN,
      cookie: `campus_session=${await token()}`,
    });
    await conn.first;

    const working = accounts.find;
    accounts.find = async () => {
      throw new Error('database unavailable');
    };
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    accounts.find = working;

    expect(world.gateway.connections.size).toBe(1);
    conn.ws.close();
    await conn.settled;
  }, 15_000);

  it('closes a socket once its session expires', async () => {
    const almostExpired = await signSessionToken(
      {
        epoch: 0,
        userId: 'user-2',
        email: 'grace@campus.local',
        scope: SessionScope.FullAccess,
      },
      { secret: SECRET, ttlMinutes: 30 },
      new Date(Date.now() - 29.97 * 60_000),
    );
    const conn = connect({
      origin: ORIGIN,
      cookie: `campus_session=${almostExpired.token}`,
    });
    await conn.first;

    await expect(conn.settled).resolves.toMatchObject({ closeCode: 1008 });
    expect(world.gateway.connections.size).toBe(0);
  }, 15_000);
});

/**
 * An access token lasts fifteen minutes and is swapped for a new one through
 * campus-api, which an open socket never sees. A socket whose token names its
 * login follows that login instead of the token.
 */
describe('a socket following its login', () => {
  const SESSION = 'aaaaaaaa-0000-4000-8000-00000000abcd';

  async function signed(minutesAgo: number, sessionId = SESSION) {
    const { token } = await signSessionToken(
      {
        epoch: 0,
        userId: 'user-3',
        email: 'lin@campus.local',
        scope: SessionScope.FullAccess,
        sessionId,
      },
      { secret: SECRET, ttlMinutes: 30 },
      new Date(Date.now() - minutesAgo * 60_000),
    );
    return token;
  }

  it('outlives the access token it opened with while the login is live', async () => {
    // Expires a couple of seconds in, then the heartbeat runs twice more.
    const conn = connect({
      origin: ORIGIN,
      cookie: `campus_session=${await signed(29.97)}`,
    });
    await conn.first;

    await new Promise((resolve) => setTimeout(resolve, 3_500));

    expect(conn.ws.readyState).toBe(WebSocket.OPEN);
    conn.ws.close();
    await conn.settled;
  }, 15_000);

  /** Signing out revokes the login; the socket must not wait out a token. */
  it('closes once the login ends, and keeps the position for signing back in', async () => {
    const conn = connect({
      origin: ORIGIN,
      cookie: `campus_session=${await signed(0)}`,
    });
    await conn.first;

    accounts.endedSessions.add(SESSION);

    await expect(conn.settled).resolves.toMatchObject({
      closeCode: 1008,
      closeReason: 'session_ended',
    });
    await expect
      .poll(() => world.gateway.players.isRemembered('user-3', COHORT))
      .toBe(true);
  }, 15_000);

  /** A token lifted from a browser that has since signed out. */
  it('refuses an upgrade whose login has ended', async () => {
    accounts.endedSessions.add(SESSION);
    const { first } = connect({
      origin: ORIGIN,
      cookie: `campus_session=${await signed(0)}`,
    });

    await expect(first).resolves.toMatchObject({ message: 'session_ended' });
  });

  it('leaves sockets alone when the session check fails', async () => {
    const conn = connect({
      origin: ORIGIN,
      cookie: `campus_session=${await signed(0)}`,
    });
    await conn.first;

    const working = accounts.liveSessions;
    accounts.liveSessions = async () => {
      throw new Error('database unavailable');
    };
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    accounts.liveSessions = working;

    expect(conn.ws.readyState).toBe(WebSocket.OPEN);
    conn.ws.close();
    await conn.settled;
  }, 15_000);
});

/**
 * The upgrade asks about the cohort once, and nothing behind an open socket
 * keeps that answer true. A guest's visit has an end date, and neither the
 * access token the socket opened with nor the login it follows runs out with
 * it — so the heartbeat asks again.
 */
describe('re-checking the cohort a socket named', () => {
  const GUEST = 'guest-1';

  async function arrive() {
    const conn = connect({
      origin: ORIGIN,
      cookie: `campus_session=${await token(
        SessionScope.FullAccess,
        SECRET,
        GUEST,
      )}`,
    });
    await conn.first;
    return conn;
  }

  it('closes a guest within one sweep of the end of their visit', async () => {
    const ends = new Date(Date.now() + 60_000);
    accounts.visitEnds.set(`${GUEST}:${COHORT}`, ends);
    // Welcome: the visit still has a minute to run when the upgrade decides.
    const conn = await arrive();
    expect(world.gateway.connections.size).toBe(1);

    // Move the clock past the end of the visit. Only Date is faked: the
    // sweep that notices is a real interval, and the socket answers its
    // pings on real time.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(ends.getTime() + 1) });
    try {
      await expect(conn.settled).resolves.toMatchObject({
        closeCode: 1008,
        closeReason: 'not_a_member',
      });
    } finally {
      vi.useRealTimers();
    }

    expect(world.gateway.connections.size).toBe(0);
    // A visit that runs out is not access being taken away: the position is
    // kept, for the visit an admin may extend, as an upgrade refused for
    // not_a_member keeps it too.
    expect(world.gateway.players.isRemembered(GUEST, COHORT)).toBe(true);
  }, 15_000);

  /** Campus-api's sign-in gate admits an admin on their role alone; so does this. */
  it('leaves an admin alone when their cohort membership ends', async () => {
    accounts.admins.add(GUEST);
    const conn = await arrive();
    accounts.notMembers.add(`${GUEST}:${COHORT}`);

    // Through at least one sweep, and still here.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(conn.ws.readyState).toBe(WebSocket.OPEN);

    conn.ws.close();
    await conn.settled;
  }, 15_000);

  /** A database that is not answering must not throw the campus off. */
  it('leaves sockets alone when the membership check fails', async () => {
    const conn = await arrive();

    const working = accounts.liveMembership;
    accounts.liveMembership = async () => {
      throw new Error('database unavailable');
    };
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    accounts.liveMembership = working;

    expect(conn.ws.readyState).toBe(WebSocket.OPEN);
    conn.ws.close();
    await conn.settled;
  }, 15_000);
});

/** A promise and the hands to settle it, for calls that must stay in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('oneAtATime', () => {
  it('does not start a task again while the last run is still going', async () => {
    const runs: ReturnType<typeof deferred<void>>[] = [];
    const run = oneAtATime(
      () => {
        const next = deferred<void>();
        runs.push(next);
        return next.promise;
      },
      () => undefined,
    );

    run();
    run();
    run();
    expect(runs).toHaveLength(1);

    runs[0]!.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    run();
    expect(runs).toHaveLength(2);
  });

  /** An unhandled rejection would take the process down. */
  it('hands a failure to onError and runs again afterwards', async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const run = oneAtATime(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('database unavailable');
      },
      (err) => errors.push(err),
    );

    run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    run();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors).toHaveLength(1);
    expect(calls).toBe(2);
  });
});

/**
 * A session check slower than the heartbeat must not be joined by another:
 * two in flight could resolve out of order, and a check that started earlier
 * would have the last word.
 */
describe('a slow session check', () => {
  it('stays the only one in flight until it answers', async () => {
    const SESSION = 'aaaaaaaa-0000-4000-8000-00000000beef';
    const { token } = await signSessionToken(
      {
        epoch: 0,
        userId: 'user-4',
        email: 'kay@campus.local',
        scope: SessionScope.FullAccess,
        sessionId: SESSION,
      },
      { secret: SECRET, ttlMinutes: 30 },
    );
    const conn = connect({ origin: ORIGIN, cookie: `campus_session=${token}` });
    await conn.first;

    const pending: ReturnType<typeof deferred<Set<string>>>[] = [];
    const working = accounts.liveSessions;
    accounts.liveSessions = () => {
      const next = deferred<Set<string>>();
      pending.push(next);
      return next.promise;
    };
    try {
      // At least three heartbeats at one second each.
      await new Promise((resolve) => setTimeout(resolve, 3_500));
      expect(pending).toHaveLength(1);

      // The check answers, late: the session is live. The socket stays, and
      // the next heartbeat starts a fresh check.
      pending[0]!.resolve(new Set([SESSION]));
      await expect.poll(() => pending.length, { timeout: 3_000 }).toBe(2);
      expect(conn.ws.readyState).toBe(WebSocket.OPEN);
      pending[1]!.resolve(new Set([SESSION]));
    } finally {
      accounts.liveSessions = working;
      for (const call of pending) call.resolve(new Set([SESSION]));
    }

    conn.ws.close();
    await conn.settled;
  }, 15_000);
});

describe('an open socket', () => {
  async function open() {
    const conn = connect({
      origin: ORIGIN,
      cookie: `campus_session=${await token()}`,
    });
    // The snapshot, not merely the first frame: welcome and snapshot are sent
    // together, and a reply() started between them would catch the snapshot.
    await waitFor(conn, (m) => m.type === 'snapshot');
    return conn;
  }

  const reply = (conn: { ws: WebSocket }, send: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      conn.ws.once('message', (raw) =>
        resolve(JSON.parse(raw.toString()) as Record<string, unknown>),
      );
      conn.ws.send(JSON.stringify(send));
    });

  it('answers a ping', async () => {
    const conn = await open();

    await expect(reply(conn, { type: 'ping' })).resolves.toEqual({
      type: 'pong',
    });
    conn.ws.close();
  });

  it('rejects a frame it cannot parse without dropping the socket', async () => {
    const conn = await open();

    await expect(reply(conn, 'not-an-envelope')).resolves.toMatchObject({
      type: 'error',
      code: 'BAD_MESSAGE',
    });
    expect(conn.ws.readyState).toBe(WebSocket.OPEN);
    conn.ws.close();
  });

  it('rejects a message type it does not know', async () => {
    const conn = await open();

    await expect(
      reply(conn, { type: 'teleport', to: 'anywhere' }),
    ).resolves.toMatchObject({ code: 'BAD_MESSAGE' });
    conn.ws.close();
  });

  it('counts the connection while it is open, and forgets it after', async () => {
    const conn = await open();
    expect(world.gateway.connections.size).toBe(1);
    expect(world.gateway.connections.forUser('user-1')).toHaveLength(1);

    conn.ws.close();
    await conn.settled;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(world.gateway.connections.size).toBe(0);
  });

  it('replaces the socket a person already had open', async () => {
    const one = await open();
    const two = await open();

    await one.settled;
    expect(world.gateway.connections.forUser('user-1')).toHaveLength(1);
    expect(world.gateway.connections.size).toBe(1);
    expect(world.gateway.connections.users).toBe(1);

    one.ws.close();
    two.ws.close();
    await Promise.all([one.settled, two.settled]);
  });
});

describe('movement', () => {
  let nextUser = 0;
  /** A fresh person per test, so nobody starts where an earlier test left them. */
  const person = () => `walker-${++nextUser}`;

  async function arrive(userId: string, cohortId = COHORT) {
    const conn = connect(
      {
        origin: ORIGIN,
        cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, userId)}`,
      },
      cohortId,
    );
    await waitFor(conn, (m) => m.type === 'snapshot');
    return conn;
  }

  async function leave(conn: ReturnType<typeof connect>) {
    conn.ws.close();
    await conn.settled;
  }

  const move = (conn: { ws: WebSocket }, direction: string, seq: number) =>
    conn.ws.send(JSON.stringify({ type: 'move', direction, seq }));

  /** Long enough that anything the server was going to send has arrived. */
  const quiet = () => new Promise((resolve) => setTimeout(resolve, 150));

  it('shows an arrival the map and everybody on it, themselves included', async () => {
    const ada = person();
    const grace = person();
    const first = await arrive(ada);
    const second = await arrive(grace);

    const snapshot = await waitFor(second, (m) => m.type === 'snapshot');
    // Which map and version, so the client loads the one enforced here.
    expect(snapshot).toMatchObject({
      map: { id: 'campus', version: 'v-test', width: 5, height: 5 },
    });
    expect(positionsIn(snapshot)).toEqual(
      expect.arrayContaining([
        { userId: ada, x: 0, y: 0, facing: 'down' },
        { userId: grace, x: 0, y: 0, facing: 'down' },
      ]),
    );

    await leave(first);
    await leave(second);
  });

  it('tells everybody already here that somebody arrived', async () => {
    const ada = person();
    const grace = person();
    const first = await arrive(ada);
    const second = await arrive(grace);

    await expect(waitFor(first, (m) => m.type === 'joined')).resolves.toEqual({
      type: 'joined',
      player: {
        userId: grace,
        x: 0,
        y: 0,
        facing: 'down',
        displayName: null,
        spriteKey: null,
      },
    });
    // Learns about themselves from the snapshot, not from a joined.
    await quiet();
    expect(second.messages.some((m) => m.type === 'joined')).toBe(false);

    await leave(first);
    await leave(second);
  });

  describe('what to draw for each player', () => {
    it('tells an arrival their own sprite and name in the welcome', async () => {
      const ada = person();
      accounts.looks.set(ada, {
        displayName: 'Ada L.',
        spriteKey: 'placeholder-2',
      });

      const conn = await arrive(ada);

      await expect(
        waitFor(conn, (m) => m.type === 'welcome'),
      ).resolves.toMatchObject({
        userId: ada,
        displayName: 'Ada L.',
        spriteKey: 'placeholder-2',
      });
      await leave(conn);
    });

    it('sends everybody’s sprite and name with the snapshot and with joined', async () => {
      const ada = person();
      const grace = person();
      accounts.looks.set(ada, {
        displayName: 'Ada L.',
        spriteKey: 'placeholder-1',
      });
      accounts.looks.set(grace, {
        displayName: 'Grace H.',
        spriteKey: 'placeholder-3',
      });
      const first = await arrive(ada);
      const second = await arrive(grace);

      await expect(
        waitFor(first, (m) => m.type === 'joined'),
      ).resolves.toMatchObject({
        player: {
          userId: grace,
          displayName: 'Grace H.',
          spriteKey: 'placeholder-3',
        },
      });
      const snapshot = await waitFor(second, (m) => m.type === 'snapshot');
      expect(snapshot.players).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userId: ada,
            displayName: 'Ada L.',
            spriteKey: 'placeholder-1',
          }),
          expect.objectContaining({
            userId: grace,
            displayName: 'Grace H.',
            spriteKey: 'placeholder-3',
          }),
        ]),
      );

      await leave(first);
      await leave(second);
    });

    it('keeps moves to the position alone', async () => {
      const ada = person();
      accounts.looks.set(ada, {
        displayName: 'Ada L.',
        spriteKey: 'placeholder-1',
      });
      const walker = await arrive(ada);
      const watcher = await arrive(person());

      move(walker, 'right', 1);

      const moved = await waitFor(watcher, (m) => m.type === 'moved');
      expect(moved.players).toEqual([
        { userId: ada, x: 1, y: 0, facing: 'right' },
      ]);

      await leave(walker);
      await leave(watcher);
    });

    /**
     * campus-api notifies world in the same transaction as the save, so a
     * change reaches everybody in the cohort, its owner's own tab included,
     * without anybody leaving or entering.
     */
    it('shows a changed sprite to the whole cohort as soon as it is saved', async () => {
      const ada = person();
      accounts.looks.set(ada, {
        displayName: 'Ada L.',
        spriteKey: 'placeholder-1',
      });
      const own = await arrive(ada);
      const watcher = await arrive(person());
      const elsewhere = await arrive(person(), 'cohort-backend');
      await quiet();

      accounts.changeLooks(ada, {
        displayName: 'Ada L.',
        spriteKey: 'placeholder-4',
      });

      // Well inside one heartbeat, so it is the notification that did it.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const expected = {
        type: 'appearance',
        userId: ada,
        displayName: 'Ada L.',
        spriteKey: 'placeholder-4',
      };
      expect(watcher.messages).toContainEqual(expected);
      expect(own.messages).toContainEqual(expected);
      await quiet();
      expect(elsewhere.messages.some((m) => m.type === 'appearance')).toBe(
        false,
      );

      // And whoever comes in next draws the new one from the snapshot.
      const late = await arrive(person());
      const snapshot = await waitFor(late, (m) => m.type === 'snapshot');
      expect(snapshot.players).toContainEqual(
        expect.objectContaining({ userId: ada, spriteKey: 'placeholder-4' }),
      );

      await leave(own);
      await leave(watcher);
      await leave(elsewhere);
      await leave(late);
    });

    it('says nothing when what is drawn did not change', async () => {
      const ada = person();
      const looks = { displayName: 'Ada L.', spriteKey: 'placeholder-2' };
      accounts.looks.set(ada, looks);
      const own = await arrive(ada);
      const watcher = await arrive(person());
      await quiet();

      accounts.changeLooks(ada, { ...looks });
      await quiet();

      expect(watcher.messages.some((m) => m.type === 'appearance')).toBe(false);
      await leave(own);
      await leave(watcher);
    });

    /**
     * A notification sent while this process was reconnecting to the
     * database is lost. The heartbeat reads every account anyway, and shows
     * the change then.
     */
    it('catches a change it was never told of on the next heartbeat', async () => {
      const ada = person();
      const own = await arrive(ada);
      const watcher = await arrive(person());
      await quiet();

      accounts.looks.set(ada, {
        displayName: 'Ada L.',
        spriteKey: 'placeholder-3',
      });

      await expect(
        waitFor(watcher, (m) => m.type === 'appearance'),
      ).resolves.toMatchObject({ userId: ada, spriteKey: 'placeholder-3' });
      await leave(own);
      await leave(watcher);
    });
  });

  it('stops somebody at a wall, facing it', async () => {
    const ada = person();
    const walker = await arrive(ada);

    move(walker, 'down', 1);
    move(walker, 'down', 2);

    await expect(
      waitFor(walker, (m) => m.type === 'moveResult' && m.seq === 2),
    ).resolves.toEqual({
      type: 'moveResult',
      seq: 2,
      outcome: 'blocked',
      player: { userId: ada, x: 0, y: 1, facing: 'down' },
    });

    await leave(walker);
  });

  it('answers a step with where the server has them, and shows it to others', async () => {
    const ada = person();
    const walker = await arrive(ada);
    const watcher = await arrive(person());

    move(walker, 'right', 7);

    await expect(
      waitFor(walker, (m) => m.type === 'moveResult'),
    ).resolves.toEqual({
      type: 'moveResult',
      seq: 7,
      outcome: 'moved',
      player: { userId: ada, x: 1, y: 0, facing: 'right' },
    });
    await expect(waitFor(watcher, (m) => m.type === 'moved')).resolves.toEqual({
      type: 'moved',
      players: [{ userId: ada, x: 1, y: 0, facing: 'right' }],
    });
    // The mover has its answer; a moved as well would draw the step twice.
    await quiet();
    expect(walker.messages.some((m) => m.type === 'moved')).toBe(false);

    await leave(walker);
    await leave(watcher);
  });

  it('keeps them on the map, and says so', async () => {
    const walker = await arrive(person());

    move(walker, 'up', 1);

    await expect(
      waitFor(walker, (m) => m.type === 'moveResult'),
    ).resolves.toMatchObject({
      seq: 1,
      outcome: 'blocked',
      player: { x: 0, y: 0, facing: 'up' },
    });

    await leave(walker);
  });

  /** A modified client that sends a flood of steps gets the walking speed and no more. */
  it('refuses steps faster than walking pace', async () => {
    const walker = await arrive(person());

    for (let seq = 0; seq < 6; seq++) move(walker, 'down', seq);
    await waitFor(walker, (m) => m.type === 'moveResult' && m.seq === 5);

    const results = walker.messages.filter((m) => m.type === 'moveResult');
    expect(results.map((m) => m.outcome)).toContain('too_fast');
    // Wherever they ended up, it was not six tiles away.
    const last = results.at(-1) as { player: { y: number } };
    expect(last.player.y).toBeLessThan(6);

    await leave(walker);
  });

  /**
   * The point of the tick: steps are told to everybody once per tick, not
   * once per step, and only where the walker ended up.
   */
  it('tells others about several quick steps in fewer frames, ending where the walker did', async () => {
    const ada = person();
    const walker = await arrive(ada);
    const watcher = await arrive(person());

    for (let seq = 0; seq < 3; seq++) move(walker, 'right', seq);
    await waitFor(walker, (m) => m.type === 'moveResult' && m.seq === 2);
    await waitFor(watcher, (m) => m.type === 'moved');
    await new Promise((resolve) => setTimeout(resolve, 450));

    const frames = watcher.messages.filter((m) => m.type === 'moved') as {
      players: { userId: string; x: number }[];
    }[];
    // Usually one; two if a tick happened to fall between the steps.
    expect(frames.length).toBeLessThan(3);
    const entries = frames.flatMap((frame) => frame.players);
    expect(entries.every((entry) => entry.userId === ada)).toBe(true);
    expect(entries.at(-1)).toMatchObject({ x: 3 });

    await leave(walker);
    await leave(watcher);
  });

  it('sends nothing on a tick when nobody moved', async () => {
    const watcher = await arrive(person());

    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(watcher.messages.some((m) => m.type === 'moved')).toBe(false);
    await leave(watcher);
  });

  /**
   * An update still waiting for the tick must not bring back somebody who
   * left. Can only catch that when no tick falls in the few milliseconds
   * between the step and the leave — nearly always, never guaranteed — but
   * never fails on correct code.
   */
  it('never reports a step after the walker has left', async () => {
    const ada = person();
    const walker = await arrive(ada);
    const watcher = await arrive(person());

    move(walker, 'right', 1);
    await waitFor(walker, (m) => m.type === 'moveResult');
    await leave(walker);
    await waitFor(watcher, (m) => m.type === 'left');
    await new Promise((resolve) => setTimeout(resolve, 450));

    const leftAt = watcher.messages.findIndex((m) => m.type === 'left');
    const afterLeft = watcher.messages.slice(leftAt + 1);
    expect(afterLeft.some((m) => m.type === 'moved')).toBe(false);

    await leave(watcher);
  });

  /**
   * Walking speed limits what a flood of moves can do, not how many arrive:
   * each would still be parsed and answered. Past the message budget they
   * close the connection before parsing.
   */
  it('closes a socket that exceeds its message budget', async () => {
    const flooder = await arrive(person());

    for (let i = 0; i < 200; i++)
      flooder.ws.send(JSON.stringify({ type: 'ping' }));

    await expect(flooder.settled).resolves.toMatchObject({
      closeCode: 1008,
      closeReason: 'rate_limited',
    });
    // At most one second's budget was answered before the close.
    const pongs = flooder.messages.filter((m) => m.type === 'pong').length;
    expect(pongs).toBeGreaterThan(0);
    expect(pongs).toBeLessThanOrEqual(20);
  });

  it('rejects a direction that is not one of the four', async () => {
    const walker = await arrive(person());

    move(walker, 'northeast', 1);

    await expect(
      waitFor(walker, (m) => m.type === 'error'),
    ).resolves.toMatchObject({
      code: 'BAD_MESSAGE',
    });
    await leave(walker);
  });

  it('tells everybody when somebody leaves', async () => {
    const ada = person();
    const leaving = await arrive(ada);
    const staying = await arrive(person());

    await leave(leaving);

    await expect(waitFor(staying, (m) => m.type === 'left')).resolves.toEqual({
      type: 'left',
      userId: ada,
    });
    expect(world.gateway.players.has(ada, COHORT)).toBe(false);

    await leave(staying);
  });

  /** One cohort, one device, one tab: the newest connection wins. */
  /**
   * Each cohort is its own campus. Two of them may share this process and
   * the map it loaded, and still nobody in one sees or hears of anybody in
   * the other.
   */
  describe('cohorts kept apart', () => {
    const ofCohort = (conn: { messages: Record<string, unknown>[] }) =>
      conn.messages.filter((m) =>
        ['joined', 'left', 'moved'].includes(m.type as string),
      );

    it('shows an arrival only the people in the cohort they entered', async () => {
      const ada = person();
      const grace = person();
      const inFrontend = await arrive(ada, 'cohort-frontend');
      const inBackend = await arrive(grace, 'cohort-backend');

      const snapshot = await waitFor(inBackend, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toEqual([
        { userId: grace, x: 0, y: 0, facing: 'down' },
      ]);
      await quiet();
      expect(ofCohort(inFrontend)).toEqual([]);

      await leave(inFrontend);
      await leave(inBackend);
    });

    it('tells a move, and a departure, to nobody in another cohort', async () => {
      const ada = person();
      const inFrontend = await arrive(ada, 'cohort-frontend');
      const sameCohort = await arrive(person(), 'cohort-frontend');
      const otherCohort = await arrive(person(), 'cohort-backend');

      move(inFrontend, 'right', 1);
      await expect(
        waitFor(sameCohort, (m) => m.type === 'moved'),
      ).resolves.toEqual({
        type: 'moved',
        players: [{ userId: ada, x: 1, y: 0, facing: 'right' }],
      });
      await leave(inFrontend);
      await expect(
        waitFor(sameCohort, (m) => m.type === 'left' && m.userId === ada),
      ).resolves.toBeDefined();

      await quiet();
      expect(ofCohort(otherCohort)).toEqual([]);

      await leave(sameCohort);
      await leave(otherCohort);
    });

    /**
     * Somebody standing in two cohorts at once has an avatar in each, and a
     * step in one is news only to the people in that one.
     */
    it('keeps a step in one cohort out of the other, for somebody in both', async () => {
      const ada = person();
      const frontendWatcher = await arrive(person(), 'cohort-frontend');
      const backendWatcher = await arrive(person(), 'cohort-backend');
      const inFrontend = await arrive(ada, 'cohort-frontend');
      const inBackend = await arrive(ada, 'cohort-backend');

      move(inFrontend, 'right', 1);

      await expect(
        waitFor(frontendWatcher, (m) => m.type === 'moved'),
      ).resolves.toEqual({
        type: 'moved',
        players: [{ userId: ada, x: 1, y: 0, facing: 'right' }],
      });
      // Through at least one tick: Backend hears nothing of it, and its
      // avatar for them has not moved.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(backendWatcher.messages.some((m) => m.type === 'moved')).toBe(
        false,
      );
      expect(inBackend.messages.some((m) => m.type === 'moved')).toBe(false);
      expect(world.gateway.players.get(ada, 'cohort-backend')).toMatchObject({
        x: 0,
        y: 0,
      });

      for (const conn of [
        inFrontend,
        inBackend,
        frontendWatcher,
        backendWatcher,
      ]) {
        await leave(conn);
      }
    });

    /** The same, for somebody who closed their socket first. */
    it('does not carry it in after leaving and coming back elsewhere', async () => {
      const ada = person();
      const backendWatcher = await arrive(person(), 'cohort-backend');
      const inFrontend = await arrive(ada, 'cohort-frontend');

      move(inFrontend, 'right', 1);
      await waitFor(inFrontend, (m) => m.type === 'moveResult');
      await leave(inFrontend);
      const inBackend = await arrive(ada, 'cohort-backend');

      await waitFor(backendWatcher, (m) => m.type === 'joined');
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(backendWatcher.messages.some((m) => m.type === 'moved')).toBe(
        false,
      );

      await leave(inBackend);
      await leave(backendWatcher);
    });

    /**
     * Back in the same cohort inside the tick, `joined` already says where
     * they stand; the step they took before leaving is not news after it.
     */
    it('does not repeat a step as a move once they have left and come back', async () => {
      const ada = person();
      const watcher = await arrive(person(), 'cohort-frontend');
      const first = await arrive(ada, 'cohort-frontend');

      move(first, 'right', 1);
      await waitFor(first, (m) => m.type === 'moveResult');
      await leave(first);
      const second = await arrive(ada, 'cohort-frontend');

      // The second `joined` for them, one tile right of where the first was.
      const rejoined = (m: Record<string, unknown>) =>
        m.type === 'joined' && (m.player as { x: number }).x === 1;
      await expect(waitFor(watcher, rejoined)).resolves.toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const after = watcher.messages.slice(
        watcher.messages.findIndex(rejoined),
      );
      expect(after.some((m) => m.type === 'moved')).toBe(false);

      await leave(second);
      await leave(watcher);
    });

    /** One tick may carry moves from several cohorts; each hears its own. */
    it('sorts the moves of one tick by cohort', async () => {
      const ada = person();
      const grace = person();
      const inFrontend = await arrive(ada, 'cohort-frontend');
      const inBackend = await arrive(grace, 'cohort-backend');
      const frontendWatcher = await arrive(person(), 'cohort-frontend');
      const backendWatcher = await arrive(person(), 'cohort-backend');

      move(inFrontend, 'right', 1);
      move(inBackend, 'down', 1);

      await expect(
        waitFor(frontendWatcher, (m) => m.type === 'moved'),
      ).resolves.toEqual({
        type: 'moved',
        players: [{ userId: ada, x: 1, y: 0, facing: 'right' }],
      });
      await expect(
        waitFor(backendWatcher, (m) => m.type === 'moved'),
      ).resolves.toEqual({
        type: 'moved',
        players: [{ userId: grace, x: 0, y: 1, facing: 'down' }],
      });
      // Each mover has its own answer, and hears nothing of the other.
      await quiet();
      expect(inFrontend.messages.some((m) => m.type === 'moved')).toBe(false);
      expect(inBackend.messages.some((m) => m.type === 'moved')).toBe(false);

      for (const conn of [
        inFrontend,
        inBackend,
        frontendWatcher,
        backendWatcher,
      ]) {
        await leave(conn);
      }
    });
  });

  describe('one socket per account in each cohort', () => {
    const entryOf = (message: Record<string, unknown>) =>
      message.player as { userId: string; x: number; y: number };

    it('holds one socket for the account in a cohort, however many were opened', async () => {
      const ada = person();
      const first = await arrive(ada);
      const second = await arrive(ada);
      const third = await arrive(ada);
      await first.settled;
      await second.settled;

      expect(world.gateway.connections.forUser(ada)).toHaveLength(1);
      expect(
        world.gateway.players.in(COHORT).filter((p) => p.userId === ada),
      ).toHaveLength(1);

      await leave(third);
    });

    it('tells the socket it displaced, then closes it with 4000', async () => {
      const ada = person();
      const first = await arrive(ada);
      const second = await arrive(ada);

      await expect(
        waitFor(first, (m) => m.type === 'replaced'),
      ).resolves.toEqual({ type: 'replaced' });
      await expect(first.settled).resolves.toMatchObject({
        closeCode: 4000,
        closeReason: 'entered_elsewhere',
      });

      await leave(second);
    });

    /** The avatar must not blink out and back for everybody watching. */
    it('leaves the avatar where it stood, replacing within one cohort', async () => {
      const ada = person();
      const watcher = await arrive(person());
      const first = await arrive(ada);
      move(first, 'right', 1);
      await waitFor(first, (m) => m.type === 'moveResult');

      const second = await arrive(ada);

      const snapshot = await waitFor(second, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toContainEqual({
        userId: ada,
        x: 1,
        y: 0,
        facing: 'right',
      });

      await quiet();
      expect(
        watcher.messages.filter((m) => m.type === 'left' && m.userId === ada),
      ).toHaveLength(0);
      // The one from their original arrival, and no second one.
      expect(
        watcher.messages.filter(
          (m) => m.type === 'joined' && entryOf(m).userId === ada,
        ),
      ).toHaveLength(1);

      await leave(second);
      await leave(watcher);
    });

    /**
     * A second cohort is a second campus to stand in, not a move out of the
     * first: nobody is replaced, and nobody in the first sees them leave.
     */
    it('enters a second cohort without leaving the first', async () => {
      const ada = person();
      const frontendWatcher = await arrive(person(), 'cohort-frontend');
      const backendWatcher = await arrive(person(), 'cohort-backend');
      const inFrontend = await arrive(ada, 'cohort-frontend');
      move(inFrontend, 'right', 1);
      await waitFor(inFrontend, (m) => m.type === 'moveResult');
      // Backend already knows where they stood last time.
      store.positions.set(positionKey(ada, 'cohort-backend'), {
        x: 3,
        y: 2,
        facing: 'left',
      });

      const inBackend = await arrive(ada, 'cohort-backend');

      const snapshot = await waitFor(inBackend, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toContainEqual({
        userId: ada,
        x: 3,
        y: 2,
        facing: 'left',
      });
      await expect(
        waitFor(
          backendWatcher,
          (m) => m.type === 'joined' && entryOf(m).userId === ada,
        ),
      ).resolves.toMatchObject({ player: { userId: ada, x: 3, y: 2 } });

      await quiet();
      expect(inFrontend.ws.readyState).toBe(WebSocket.OPEN);
      expect(inFrontend.messages.some((m) => m.type === 'replaced')).toBe(
        false,
      );
      expect(
        frontendWatcher.messages.some(
          (m) => m.type === 'left' && m.userId === ada,
        ),
      ).toBe(false);
      expect(world.gateway.connections.forUser(ada)).toHaveLength(2);
      expect(world.gateway.players.get(ada, 'cohort-frontend')).toMatchObject({
        x: 1,
        y: 0,
      });

      // And the first still walks.
      move(inFrontend, 'down', 2);
      await expect(
        waitFor(inFrontend, (m) => m.type === 'moveResult' && m.seq === 2),
      ).resolves.toMatchObject({ outcome: 'moved', player: { x: 1, y: 1 } });

      for (const conn of [
        inFrontend,
        inBackend,
        frontendWatcher,
        backendWatcher,
      ]) {
        await leave(conn);
      }
    });

    it('saves each cohort where they stand in it', async () => {
      const ada = person();
      const inFrontend = await arrive(ada, 'cohort-frontend');
      const inBackend = await arrive(ada, 'cohort-backend');
      move(inFrontend, 'right', 1);
      move(inBackend, 'down', 1);
      await waitFor(inFrontend, (m) => m.type === 'moveResult');
      await waitFor(inBackend, (m) => m.type === 'moveResult');

      await leave(inFrontend);
      await leave(inBackend);

      await expect
        .poll(() => store.positions.get(positionKey(ada, 'cohort-frontend')))
        .toEqual({ x: 1, y: 0, facing: 'right' });
      await expect
        .poll(() => store.positions.get(positionKey(ada, 'cohort-backend')))
        .toEqual({ x: 0, y: 1, facing: 'down' });
    });

    it('closing one cohort leaves the other standing', async () => {
      const ada = person();
      const frontendWatcher = await arrive(person(), 'cohort-frontend');
      const backendWatcher = await arrive(person(), 'cohort-backend');
      const inFrontend = await arrive(ada, 'cohort-frontend');
      const inBackend = await arrive(ada, 'cohort-backend');

      await leave(inFrontend);

      await expect(
        waitFor(frontendWatcher, (m) => m.type === 'left' && m.userId === ada),
      ).resolves.toBeDefined();
      await quiet();
      expect(
        backendWatcher.messages.some(
          (m) => m.type === 'left' && m.userId === ada,
        ),
      ).toBe(false);
      expect(world.gateway.players.has(ada, 'cohort-backend')).toBe(true);
      expect(world.gateway.players.isRemembered(ada, 'cohort-frontend')).toBe(
        true,
      );

      await leave(inBackend);
      await leave(frontendWatcher);
      await leave(backendWatcher);
    });

    /** A suspension is about the account, so it reaches every campus it is in. */
    it('closes every cohort the account is in when it is suspended', async () => {
      const ada = person();
      const backendWatcher = await arrive(person(), 'cohort-backend');
      const inFrontend = await arrive(ada, 'cohort-frontend');
      const inBackend = await arrive(ada, 'cohort-backend');

      accounts.suspended.add(ada);

      for (const conn of [inFrontend, inBackend]) {
        await expect(conn.settled).resolves.toMatchObject({
          closeCode: 1008,
          closeReason: 'account_suspended',
        });
      }
      await expect(
        waitFor(backendWatcher, (m) => m.type === 'left' && m.userId === ada),
      ).resolves.toBeDefined();
      expect(world.gateway.connections.forUser(ada)).toEqual([]);

      accounts.suspended.delete(ada);
      await leave(backendWatcher);
    }, 15_000);

    /** The same, caught when another socket for the account is refused. */
    it('closes every cohort the account is in when a new socket is refused for suspension', async () => {
      const ada = person();
      const inFrontend = await arrive(ada, 'cohort-frontend');
      const inBackend = await arrive(ada, 'cohort-backend');

      // The heartbeat would close them too, a second later at most. The
      // refusal does it at once, before it answers the socket it refuses.
      const closedAt = (conn: { settled: Promise<unknown> }) =>
        conn.settled.then(() => Date.now());
      const frontendClosed = closedAt(inFrontend);
      const backendClosed = closedAt(inBackend);
      accounts.suspended.add(ada);
      const refused = connect(
        {
          origin: ORIGIN,
          cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, ada)}`,
        },
        'cohort-design',
      );

      const refusedAt = await closedAt(refused);
      for (const conn of [inFrontend, inBackend]) {
        await expect(conn.settled).resolves.toMatchObject({
          closeCode: 1008,
          closeReason: 'account_suspended',
        });
      }
      for (const closed of [frontendClosed, backendClosed]) {
        expect(await closed).toBeLessThanOrEqual(refusedAt + 100);
      }
      expect(world.gateway.connections.forUser(ada)).toEqual([]);

      accounts.suspended.delete(ada);
    }, 15_000);

    it('shows a changed look in every cohort they are in, each once', async () => {
      const ada = person();
      const frontendWatcher = await arrive(person(), 'cohort-frontend');
      const backendWatcher = await arrive(person(), 'cohort-backend');
      const inFrontend = await arrive(ada, 'cohort-frontend');
      const inBackend = await arrive(ada, 'cohort-backend');
      await quiet();

      accounts.changeLooks(ada, {
        displayName: 'Ada L.',
        spriteKey: 'placeholder-2',
      });
      await quiet();

      for (const conn of [
        frontendWatcher,
        backendWatcher,
        inFrontend,
        inBackend,
      ]) {
        expect(
          conn.messages.filter(
            (m) => m.type === 'appearance' && m.userId === ada,
          ),
        ).toHaveLength(1);
      }

      for (const conn of [
        inFrontend,
        inBackend,
        frontendWatcher,
        backendWatcher,
      ]) {
        await leave(conn);
      }
    });

    /** The heartbeat asks the database about an account, not about each of its sockets. */
    it('reads an account once a sweep, however many cohorts it is in', async () => {
      const ada = person();
      const grace = person();
      const sockets = [
        await arrive(ada, 'cohort-frontend'),
        await arrive(ada, 'cohort-backend'),
        await arrive(ada, 'cohort-design'),
        await arrive(grace, 'cohort-frontend'),
      ];
      const find = vi.spyOn(accounts, 'find');
      try {
        // Across a few heartbeats: whatever number of sweeps ran, ada was
        // asked about exactly as often as grace, who has one socket.
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        const askedAbout = (userId: string) =>
          find.mock.calls.filter(([id]) => id === userId).length;
        expect(askedAbout(grace)).toBeGreaterThan(0);
        expect(askedAbout(ada)).toBe(askedAbout(grace));
      } finally {
        find.mockRestore();
      }
      for (const conn of sockets) await leave(conn);
    }, 15_000);

    /** A reconnect within the grace resumes in its own cohort, whatever else they are in. */
    it('resumes a cohort where they left it while standing in another', async () => {
      const ada = person();
      const inBackend = await arrive(ada, 'cohort-backend');
      const first = await arrive(ada, 'cohort-frontend');
      move(first, 'right', 1);
      await waitFor(first, (m) => m.type === 'moveResult');
      await leave(first);
      await expect
        .poll(() => world.gateway.players.isRemembered(ada, 'cohort-frontend'))
        .toBe(true);

      const again = await arrive(ada, 'cohort-frontend');

      const snapshot = await waitFor(again, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toContainEqual({
        userId: ada,
        x: 1,
        y: 0,
        facing: 'right',
      });
      await leave(again);
      await leave(inBackend);
    });

    it('keeps the avatar until the surviving socket closes', async () => {
      const ada = person();
      const watcher = await arrive(person());
      const first = await arrive(ada);
      const second = await arrive(ada);
      await first.settled;

      await quiet();
      expect(world.gateway.players.has(ada, COHORT)).toBe(true);
      expect(
        watcher.messages.some((m) => m.type === 'left' && m.userId === ada),
      ).toBe(false);

      await leave(second);
      await expect(
        waitFor(watcher, (m) => m.type === 'left' && m.userId === ada),
      ).resolves.toBeDefined();

      await leave(watcher);
    });

    it('leaves the newest socket in charge of the avatar', async () => {
      const ada = person();
      const first = await arrive(ada);
      const second = await arrive(ada);
      await first.settled;

      move(second, 'down', 1);
      await expect(
        waitFor(second, (m) => m.type === 'moveResult'),
      ).resolves.toMatchObject({ outcome: 'moved', player: { x: 0, y: 1 } });

      await leave(second);
    });
  });

  /**
   * The upgrade loads the account's saved position for the cohort it is
   * entering, and that read is the one step that waits. A second connection
   * for the same account can take its place while it does: these tests hold a
   * cohort's load open to make that race reliable.
   */
  /**
   * The upgrade loads the account's saved position for the cohort it is
   * entering, and that read is the one step that waits. Another connection
   * for the same account can arrive while it does: these tests hold a
   * cohort's load open to make that reliable.
   */
  describe('a connection that waits for its saved position', () => {
    const cookie = async (userId: string) =>
      `campus_session=${await token(SessionScope.FullAccess, SECRET, userId)}`;

    /**
     * Holds every load for one cohort until `release`. A load already waiting
     * still gets the release; later loads for that cohort do not wait.
     */
    function hold(cohortId: string) {
      const gate = deferred<void>();
      store.heldLoads.set(cohortId, gate.promise);
      return {
        release: () => {
          store.heldLoads.delete(cohortId);
          gate.resolve();
        },
      };
    }

    it('replaces without an extra save when the second connection is the same cohort', async () => {
      const ada = person();
      store.positions.set(positionKey(ada, 'cohort-backend'), {
        x: 3,
        y: 2,
        facing: 'left',
      });
      const backend = hold('cohort-backend');

      const first = connect(
        { origin: ORIGIN, cookie: await cookie(ada) },
        'cohort-backend',
      );
      const second = connect(
        { origin: ORIGIN, cookie: await cookie(ada) },
        'cohort-backend',
      );
      await expect.poll(() => store.loads).toBe(2);

      backend.release();

      const snapshot = await waitFor(second, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toContainEqual({
        userId: ada,
        x: 3,
        y: 2,
        facing: 'left',
      });
      await first.settled;
      expect(world.gateway.connections.forUser(ada)).toHaveLength(1);
      // Same-cohort replacement leaves the avatar untouched and writes
      // nothing: the store still holds only Backend's own saved position.
      expect(store.positions.get(positionKey(ada, 'cohort-backend'))).toEqual({
        x: 3,
        y: 2,
        facing: 'left',
      });

      await leave(second);
    });

    it('aborts a socket that closes while its load is in flight, with no avatar and no write', async () => {
      const ada = person();
      const backend = hold('cohort-backend');

      const dying = connect(
        { origin: ORIGIN, cookie: await cookie(ada) },
        'cohort-backend',
      );
      await expect.poll(() => store.loads).toBe(1);

      // The socket is paused while it waits, so a close handshake cannot
      // finish; dropping the connection is how the server learns it is gone.
      dying.ws.terminate();
      await dying.settled;
      await quiet();

      backend.release();
      await quiet();

      expect(world.gateway.connections.forUser(ada)).toEqual([]);
      expect(world.gateway.players.has(ada, 'cohort-backend')).toBe(false);
      expect(store.positions.size).toBe(0);
    });

    /** Another cohort meanwhile is another campus: nothing to wait for or undo. */
    it('enters its cohort as it would have, whatever the account did elsewhere meanwhile', async () => {
      const ada = person();
      const backend = hold('cohort-backend');
      const inBackend = connect(
        { origin: ORIGIN, cookie: await cookie(ada) },
        'cohort-backend',
      );
      await expect.poll(() => store.loads).toBe(1);

      const inFrontend = await arrive(ada, 'cohort-frontend');
      move(inFrontend, 'right', 1);
      await waitFor(inFrontend, (m) => m.type === 'moveResult');

      backend.release();

      const snapshot = await waitFor(inBackend, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toContainEqual({
        userId: ada,
        x: 0,
        y: 0,
        facing: 'down',
      });
      await quiet();
      expect(inFrontend.ws.readyState).toBe(WebSocket.OPEN);
      expect(world.gateway.connections.forUser(ada)).toHaveLength(2);
      expect(world.gateway.players.get(ada, 'cohort-frontend')).toMatchObject({
        x: 1,
        y: 0,
      });

      await leave(inFrontend);
      await leave(inBackend);
    });

    it('places both when two cohorts wait at once, each at its own saved position', async () => {
      const ada = person();
      store.positions.set(positionKey(ada, 'cohort-backend'), {
        x: 3,
        y: 2,
        facing: 'left',
      });
      store.positions.set(positionKey(ada, 'cohort-frontend'), {
        x: 4,
        y: 1,
        facing: 'right',
      });
      const frontend = hold('cohort-frontend');
      const backend = hold('cohort-backend');

      const inBackend = connect(
        { origin: ORIGIN, cookie: await cookie(ada) },
        'cohort-backend',
      );
      const inFrontend = connect(
        { origin: ORIGIN, cookie: await cookie(ada) },
        'cohort-frontend',
      );
      await expect.poll(() => store.loads).toBe(2);

      backend.release();
      frontend.release();

      await waitFor(inBackend, (m) => m.type === 'snapshot');
      await waitFor(inFrontend, (m) => m.type === 'snapshot');
      expect(world.gateway.players.get(ada, 'cohort-backend')).toMatchObject({
        x: 3,
        y: 2,
      });
      expect(world.gateway.players.get(ada, 'cohort-frontend')).toMatchObject({
        x: 4,
        y: 1,
      });

      await leave(inBackend);
      await leave(inFrontend);
    });
  });

  /**
   * A dropped connection — a blip, or the server cutting it for sending too
   * fast or reading too slowly — comes back where it was, not at the spawn.
   */
  describe('reconnecting', () => {
    it('comes back where it stood, not at the spawn', async () => {
      const ada = person();
      const first = await arrive(ada);
      move(first, 'right', 1);
      move(first, 'down', 2);
      await waitFor(first, (m) => m.type === 'moveResult' && m.seq === 2);
      await leave(first);

      const again = await arrive(ada);

      const snapshot = await waitFor(again, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toContainEqual({
        userId: ada,
        x: 1,
        y: 1,
        facing: 'down',
      });
      await leave(again);
    });

    /**
     * The heartbeat sweep only sees accounts that are still connected. One
     * suspended after its socket had already dropped is caught when it next
     * tries to come back.
     */
    it('forgets a kept position once a reconnect is refused for suspension', async () => {
      const ada = person();
      const first = await arrive(ada);
      move(first, 'right', 1);
      await waitFor(first, (m) => m.type === 'moveResult');
      await leave(first);
      // The client sees its close before the server has handled it.
      await expect
        .poll(() => world.gateway.players.isRemembered(ada, COHORT))
        .toBe(true);
      await expect
        .poll(() => store.positions.get(positionKey(ada)))
        .toEqual({ x: 1, y: 0, facing: 'right' });

      accounts.suspended.add(ada);
      const refused = connect({
        origin: ORIGIN,
        cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, ada)}`,
      });
      await expect(refused.first).resolves.toMatchObject({
        message: 'account_suspended',
      });
      await refused.settled;
      expect(world.gateway.players.isRemembered(ada, COHORT)).toBe(false);
      await expect
        .poll(() => store.positions.has(positionKey(ada)))
        .toBe(false);

      // Suspension lifted: welcome back, but at the spawn.
      accounts.suspended.delete(ada);
      const again = await arrive(ada);
      const snapshot = await waitFor(again, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toContainEqual({
        userId: ada,
        x: 0,
        y: 0,
        facing: 'down',
      });
      await leave(again);
    });

    it('forgets only the cohort the refusal named, leaving others', async () => {
      const ada = person();
      store.positions.set(positionKey(ada, 'cohort-frontend'), {
        x: 1,
        y: 1,
        facing: 'up',
      });
      store.positions.set(positionKey(ada, 'cohort-backend'), {
        x: 2,
        y: 2,
        facing: 'down',
      });

      accounts.suspended.add(ada);
      const refused = connect(
        {
          origin: ORIGIN,
          cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, ada)}`,
        },
        'cohort-frontend',
      );
      await refused.settled;

      await expect
        .poll(() => store.positions.has(positionKey(ada, 'cohort-frontend')))
        .toBe(false);
      // The cohort not involved in the attempt is left alone.
      expect(store.positions.has(positionKey(ada, 'cohort-backend'))).toBe(
        true,
      );
    });

    /** Gone from everybody's screen at once, and back in the same place. */
    it('shows others a departure, then an arrival where it left', async () => {
      const ada = person();
      const watcher = await arrive(person());
      const first = await arrive(ada);
      move(first, 'right', 1);
      await waitFor(first, (m) => m.type === 'moveResult');
      await leave(first);
      await waitFor(watcher, (m) => m.type === 'left' && m.userId === ada);

      const again = await arrive(ada);

      await expect(
        waitFor(
          watcher,
          (m) => m.type === 'joined' && (m.player as { x: number }).x === 1,
        ),
      ).resolves.toMatchObject({ player: { userId: ada, x: 1, y: 0 } });
      await leave(again);
      await leave(watcher);
    });
  });

  /**
   * A second tab refused for suspension, while the first is still open. The
   * open tab must be closed through the normal lifecycle — not have its
   * player removed from under it, which left it registered with nobody
   * standing for it. Whichever notices first, the refusal or the sweep, the
   * outcome is the same, so this does not depend on timing.
   */
  it('closes an open tab properly when another tab is refused for suspension', async () => {
    const ada = person();
    const open = await arrive(ada);
    const watcher = await arrive(person());

    accounts.suspended.add(ada);
    const refused = connect({
      origin: ORIGIN,
      cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, ada)}`,
    });

    await expect(refused.settled).resolves.toMatchObject({ closeCode: 1008 });
    await expect(open.settled).resolves.toMatchObject({
      closeCode: 1008,
      closeReason: 'account_suspended',
    });
    await expect(
      waitFor(watcher, (m) => m.type === 'left'),
    ).resolves.toMatchObject({
      userId: ada,
    });
    expect(world.gateway.players.has(ada, COHORT)).toBe(false);
    expect(world.gateway.connections.forUser(ada)).toEqual([]);

    await leave(watcher);
  }, 15_000);

  /** Whichever way a socket is dropped, its player must not be left standing. */
  it('removes the player when a suspension closes their socket', async () => {
    const ada = person();
    const conn = await arrive(ada);
    const watcher = await arrive(person());

    accounts.suspended.add(ada);

    await expect(conn.settled).resolves.toMatchObject({ closeCode: 1008 });
    await expect(
      waitFor(watcher, (m) => m.type === 'left'),
    ).resolves.toMatchObject({
      userId: ada,
    });
    expect(world.gateway.players.has(ada, COHORT)).toBe(false);
    // Access taken away: nothing kept to come back to.
    expect(world.gateway.players.isRemembered(ada, COHORT)).toBe(false);

    await leave(watcher);
  }, 15_000);

  /**
   * Beyond the reconnect grace, where somebody stood is kept in the store
   * (Redis in production) and they start there on their next visit.
   */
  describe('between visits', () => {
    it('starts somebody where they stood last time', async () => {
      const ada = person();
      store.positions.set(positionKey(ada), { x: 2, y: 3, facing: 'left' });

      const conn = await arrive(ada);

      const snapshot = await waitFor(conn, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toContainEqual({
        userId: ada,
        x: 2,
        y: 3,
        facing: 'left',
      });
      await leave(conn);
    });

    it('starts at the spawn when the saved tile is no longer on the map', async () => {
      const ada = person();
      store.positions.set(positionKey(ada), { x: 9, y: 9, facing: 'up' });

      const conn = await arrive(ada);

      const snapshot = await waitFor(conn, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toContainEqual({
        userId: ada,
        x: 0,
        y: 0,
        facing: 'down',
      });
      await leave(conn);
    });

    it('starts at the spawn when the saved tile is now a wall', async () => {
      const ada = person();
      store.positions.set(positionKey(ada), { ...WALL, facing: 'up' });

      const conn = await arrive(ada);

      const snapshot = await waitFor(conn, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toContainEqual({
        userId: ada,
        x: 0,
        y: 0,
        facing: 'down',
      });
      await leave(conn);
    });

    it('starts at the spawn when the store cannot answer', async () => {
      const ada = person();
      store.failLoad = true;

      const conn = await arrive(ada);

      const snapshot = await waitFor(conn, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toContainEqual({
        userId: ada,
        x: 0,
        y: 0,
        facing: 'down',
      });
      await leave(conn);
    });

    it('saves where they stood when their last tab closes', async () => {
      const ada = person();
      const conn = await arrive(ada);
      move(conn, 'right', 1);
      await waitFor(conn, (m) => m.type === 'moveResult');

      await leave(conn);

      await expect
        .poll(() => store.positions.get(positionKey(ada)))
        .toEqual({ x: 1, y: 0, facing: 'right' });
    });

    it('saves somebody who moved while they are still here', async () => {
      const ada = person();
      const conn = await arrive(ada);
      move(conn, 'down', 1);
      await waitFor(conn, (m) => m.type === 'moveResult');

      await expect
        .poll(() => store.positions.get(positionKey(ada)), { timeout: 3_000 })
        .toEqual({ x: 0, y: 1, facing: 'down' });
      await leave(conn);
    });

    /** The grace in memory is fresher than the store, and costs no round trip. */
    it('does not ask the store when reconnecting within the grace', async () => {
      const ada = person();
      const first = await arrive(ada);
      move(first, 'right', 1);
      await waitFor(first, (m) => m.type === 'moveResult');
      await leave(first);
      await expect
        .poll(() => world.gateway.players.isRemembered(ada, COHORT))
        .toBe(true);
      const loadsBefore = store.loads;

      const again = await arrive(ada);

      expect(store.loads).toBe(loadsBefore);
      const snapshot = await waitFor(again, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toContainEqual({
        userId: ada,
        x: 1,
        y: 0,
        facing: 'right',
      });
      await leave(again);
    });

    it('forgets the saved position when access is taken away', async () => {
      const ada = person();
      const conn = await arrive(ada);
      move(conn, 'right', 1);
      await waitFor(conn, (m) => m.type === 'moveResult');
      await expect
        .poll(() => store.positions.has(positionKey(ada)), { timeout: 3_000 })
        .toBe(true);

      accounts.suspended.add(ada);

      await expect(conn.settled).resolves.toMatchObject({ closeCode: 1008 });
      await expect
        .poll(() => store.positions.has(positionKey(ada)), { timeout: 3_000 })
        .toBe(false);
    }, 15_000);
  });

  describe('presence', () => {
    const connectionIdOf = async (conn: ReturnType<typeof connect>) =>
      (await waitFor(conn, (m) => m.type === 'welcome')).connectionId as string;

    it('records who is online, and in which cohort, while their socket is open', async () => {
      const ada = person();
      const conn = await arrive(ada, 'cohort-frontend');
      const connectionId = await connectionIdOf(conn);

      await expect
        .poll(() => presence.entries.get(presenceKeyOf(ada, 'cohort-frontend')))
        .toMatchObject({ connectionId, cohortId: 'cohort-frontend' });

      await leave(conn);
      await expect
        .poll(() => presence.entries.has(presenceKeyOf(ada, 'cohort-frontend')))
        .toBe(false);
    });

    it('records the space they arrive in', async () => {
      const ada = person();
      const conn = await arrive(ada);

      await expect
        .poll(() => presence.entries.get(presenceKeyOf(ada)))
        .toMatchObject({ spaceKey: '_default' });
      await leave(conn);
    });

    /** Somebody back where they stood last time is in that place's space. */
    it('records the space of a saved position they come back to', async () => {
      const ada = person();
      store.positions.set(positionKey(ada), { x: 3, y: 1, facing: 'left' });

      const conn = await arrive(ada);

      await expect
        .poll(() => presence.entries.get(presenceKeyOf(ada)))
        .toMatchObject({ spaceKey: 'library' });
      await leave(conn);
    });

    /**
     * Who is in which space has to be right the moment they cross, not at
     * the next renewal; and a step within a space is not a crossing, so it
     * costs no write.
     */
    it('writes the space as they cross into it and out of it, and not for steps within it', async () => {
      const ada = person();
      const conn = await arrive(ada);
      const crossingsOf = () =>
        presence.crossings
          .filter((entry) => entry.userId === ada)
          .map((entry) => entry.spaceKey);

      // Three steps right: the third is into the library.
      for (const [seq, direction] of ['right', 'right', 'right'].entries()) {
        move(conn, direction, seq + 1);
        await waitFor(
          conn,
          (m) => m.type === 'moveResult' && m.seq === seq + 1,
        );
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      await expect.poll(crossingsOf).toEqual(['library']);
      expect(presence.entries.get(presenceKeyOf(ada))).toMatchObject({
        spaceKey: 'library',
      });

      // Further in, still the library: no write.
      move(conn, 'right', 4);
      await waitFor(conn, (m) => m.type === 'moveResult' && m.seq === 4);
      await new Promise((resolve) => setTimeout(resolve, 60));
      move(conn, 'down', 5);
      await waitFor(conn, (m) => m.type === 'moveResult' && m.seq === 5);
      await quiet();
      expect(crossingsOf()).toEqual(['library']);

      // Back out the way they came.
      move(conn, 'up', 6);
      await waitFor(conn, (m) => m.type === 'moveResult' && m.seq === 6);
      await new Promise((resolve) => setTimeout(resolve, 60));
      for (const [i, seq] of [7, 8].entries()) {
        move(conn, 'left', seq);
        await waitFor(conn, (m) => m.type === 'moveResult' && m.seq === seq);
        await new Promise((resolve) => setTimeout(resolve, 60 + i));
      }
      await expect.poll(crossingsOf).toEqual(['library', '_default']);

      await leave(conn);
    });

    /** A turn on the spot, or a step into a wall, goes nowhere. */
    it('writes nothing for a move that goes nowhere', async () => {
      const ada = person();
      const conn = await arrive(ada);

      move(conn, 'up', 1);
      await waitFor(conn, (m) => m.type === 'moveResult' && m.seq === 1);
      await quiet();

      expect(
        presence.crossings.filter((entry) => entry.userId === ada),
      ).toEqual([]);
      await leave(conn);
    });

    it('keeps the replacing socket present once the one it replaced closes', async () => {
      const ada = person();
      const first = await arrive(ada);
      const second = await arrive(ada);
      const connectionId = await connectionIdOf(second);
      await first.settled;

      await quiet();
      expect(presence.entries.get(presenceKeyOf(ada))?.connectionId).toBe(
        connectionId,
      );

      await leave(second);
    });

    it('closes a socket whose account entered the campus on another instance', async () => {
      const ada = person();
      const watcher = await arrive(person());
      const conn = await arrive(ada);

      presence.displace({
        userId: ada,
        connectionId: await connectionIdOf(conn),
      });

      await expect(
        waitFor(conn, (m) => m.type === 'replaced'),
      ).resolves.toEqual({ type: 'replaced' });
      await expect(conn.settled).resolves.toMatchObject({
        closeCode: 4000,
        closeReason: 'entered_elsewhere',
      });
      // The avatar now stands on the other instance.
      await expect(
        waitFor(watcher, (m) => m.type === 'left' && m.userId === ada),
      ).resolves.toBeDefined();
      expect(world.gateway.players.has(ada, COHORT)).toBe(false);

      await leave(watcher);
    });

    it('ignores a displacement of a socket already replaced here', async () => {
      const ada = person();
      const first = await arrive(ada);
      const firstId = await connectionIdOf(first);
      const second = await arrive(ada);
      await first.settled;

      presence.displace({ userId: ada, connectionId: firstId });

      await quiet();
      expect(second.ws.readyState).toBe(WebSocket.OPEN);
      await leave(second);
    });

    /**
     * A newer connection to the same cohort on another instance reached Redis
     * first. This one does not take its place: it closes as if displaced.
     */
    it('closes a socket whose entry finds a newer one holding the place', async () => {
      const ada = person();
      const watcher = await arrive(person());
      presence.newerElsewhere = true;

      const conn = await arrive(ada);

      await expect(conn.settled).resolves.toMatchObject({
        closeCode: 4000,
        closeReason: 'entered_elsewhere',
      });
      expect(conn.messages).toContainEqual({ type: 'replaced' });
      await expect(
        waitFor(watcher, (m) => m.type === 'left' && m.userId === ada),
      ).resolves.toBeDefined();
      expect(presence.entries.has(presenceKeyOf(ada))).toBe(false);
      await leave(watcher);
    });

    /** The message from the other instance can be missed; the renewal cannot. */
    it('closes a socket a renewal finds displaced', async () => {
      const ada = person();
      const conn = await arrive(ada);

      presence.heldElsewhere.add(await connectionIdOf(conn));

      await expect(conn.settled).resolves.toMatchObject({
        closeCode: 4000,
        closeReason: 'entered_elsewhere',
      });
    });

    it('lets somebody in while presence cannot be written, and records them once it can', async () => {
      const ada = person();
      presence.failing = true;

      const conn = await arrive(ada);
      await quiet();
      expect(presence.entries.has(presenceKeyOf(ada))).toBe(false);

      presence.failing = false;
      await expect
        .poll(() => presence.entries.has(presenceKeyOf(ada)), {
          timeout: 3_000,
        })
        .toBe(true);
      await leave(conn);
    });
  });
});

/** A redeploy must not send everybody back to the spawn. */
describe('shutdown', () => {
  it('saves everybody still here and takes them out of presence before closing their sockets', async () => {
    const saved = new Map<string, unknown>();
    const own = await buildWorld(
      env,
      accounts,
      {
        ...store,
        save: async (players) => {
          for (const { userId, x, y, facing } of players)
            saved.set(userId, { x, y, facing });
        },
      },
      new MemoryPresenceStore(),
      map,
    );
    await own.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = own.app.server.address() as AddressInfo;
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/socket?cohortId=${COHORT}`,
      {
        headers: {
          origin: ORIGIN,
          cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, 'leaving-1')}`,
        },
      },
    );
    const closed = new Promise((resolve) => ws.on('close', resolve));
    await new Promise((resolve) => ws.on('message', resolve));
    expect(await own.presence.online(COHORT)).toHaveLength(1);

    await own.gateway.stop();

    expect(saved.get('leaving-1')).toEqual({ x: 0, y: 0, facing: 'down' });
    expect(await own.presence.online(COHORT)).toEqual([]);
    await closed;
    await own.app.close();
  });
});

/**
 * Two instances sharing one Redis, as production will run them. Needs a real
 * Redis: see WORLD_TEST_REDIS_URL in presence.spec.ts.
 */
const redisUrl = process.env.WORLD_TEST_REDIS_URL;

describe.skipIf(!redisUrl)('across instances', () => {
  const shared = loadEnv({
    AUTH_SESSION_SECRET: SECRET,
    DEPLOYMENT_ENVIRONMENT: 'development',
    DATABASE_URL: 'postgres://unused',
    CORS_ORIGINS: ORIGIN,
    REDIS_URL: redisUrl,
    FF_LOG_LEVEL: 'fatal',
  } as NodeJS.ProcessEnv);
  const cohortId = `cohort-${randomUUID()}`;
  const instances: World[] = [];
  let redis: Redis;

  async function instance(): Promise<World> {
    const own = await buildWorld(shared, accounts, store);
    instances.push(own);
    await own.app.listen({ port: 0, host: '127.0.0.1' });
    return own;
  }

  function enter(own: World, cookie: string) {
    const { port } = own.app.server.address() as AddressInfo;
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/socket?cohortId=${cohortId}`,
      { headers: { origin: ORIGIN, cookie } },
    );
    const messages: Record<string, unknown>[] = [];
    ws.on('message', (raw) =>
      messages.push(JSON.parse(raw.toString()) as Record<string, unknown>),
    );
    const closed = new Promise<[number, string]>((resolve) =>
      ws.on('close', (code, reason) => resolve([code, reason.toString()])),
    );
    return { ws, messages, closed };
  }

  beforeAll(() => {
    redis = new Redis(redisUrl as string);
  });

  afterAll(async () => {
    for (const own of instances) {
      await own.gateway.stop();
      await own.app.close();
      await own.presence.close();
      await own.positions.close();
    }
    await redis.quit();
  });

  it('closes the socket on one instance when the account enters on another', async () => {
    const first = await instance();
    const second = await instance();
    // Both listening before anybody enters, or the message has nobody to hear it.
    await expect
      .poll(async () => {
        const [, count] = (await redis.pubsub('NUMSUB', DISPLACED_CHANNEL)) as [
          string,
          number,
        ];
        return count;
      })
      .toBeGreaterThanOrEqual(2);
    const userId = `elsewhere-${randomUUID()}`;
    const cookie = `campus_session=${await token(SessionScope.FullAccess, SECRET, userId)}`;

    const onFirst = enter(first, cookie);
    await expect
      .poll(() => onFirst.messages.some((m) => m.type === 'snapshot'))
      .toBe(true);
    const onSecond = enter(second, cookie);

    await expect(onFirst.closed).resolves.toEqual([4000, 'entered_elsewhere']);
    expect(onFirst.messages).toContainEqual({ type: 'replaced' });
    expect(first.gateway.players.has(userId, cohortId)).toBe(false);
    const welcome = onSecond.messages.find((m) => m.type === 'welcome');
    await expect(second.presence.online(cohortId)).resolves.toEqual([
      expect.objectContaining({
        userId,
        connectionId: welcome?.connectionId,
        instanceId: second.presence.instanceId,
      }),
    ]);

    onSecond.ws.close();
    await onSecond.closed;
    await expect.poll(() => second.presence.online(cohortId)).toEqual([]);
  });
});
