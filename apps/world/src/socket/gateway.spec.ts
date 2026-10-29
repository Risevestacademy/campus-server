import {
  DEFAULT_SPACE_KEY,
  signSessionToken,
  SessionScope,
} from '@campus/session';
import {
  SPACE_ACCESS,
  type CohortMembershipFacts,
  type SpaceFacts,
  type SpaceGrantFacts,
} from '@campus/space-access';
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
import { STEP_BURST } from '../movement/players.js';
import { spaceIndexFrom } from '../movement/spaces.js';
import type { WorldMap } from '../movement/world-map.js';
import { seatKey, type Seat } from '../seat.js';
import {
  DISPLACED_CHANNEL,
  MemoryPresenceStore,
  type Displacement,
  type Presence,
} from '../infra/presence.js';

const SECRET = 'a-world-session-secret-of-at-least-32-chars';
const ORIGIN = 'https://campus.example.com';
const COHORT = 'cohort-1';

/** A seat in the tests' own cohort unless another is named. */
type SeatIn = Pick<Seat, 'userId'> & Partial<Seat>;

/** How the fake store keys a position: by account and cohort. */
const positionKey = ({ userId, cohortId = COHORT }: SeatIn) =>
  `${userId}:${cohortId}`;

/** As the database's own question: is this membership live at `now`? */
const isLiveMembership = async ({ userId, cohortId }: Seat, now: Date) => {
  const key = `${userId}:${cohortId}`;
  if (accounts.notMembers.has(key)) return false;
  const ends = accounts.visitEnds.get(key);
  return ends === undefined || ends > now;
};

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
          systemRole: accounts.admins.has(userId) ? 'admin' : 'user',
          sessionEpoch: accounts.epochs.get(userId) ?? 0,
          displayName: accounts.looks.get(userId)?.displayName ?? null,
          spriteKey: accounts.looks.get(userId)?.spriteKey ?? null,
        },
  liveSessions: async (ids: readonly string[]): Promise<Set<string>> =>
    new Set(ids.filter((id) => !accounts.endedSessions.has(id))),
  liveMembership: isLiveMembership,
  /** The sweep's question, asked once for every socket: the same per seat. */
  liveMemberships: async (
    seats: readonly Seat[],
    now: Date,
  ): Promise<Set<string>> => {
    const live = new Set<string>();
    for (const seat of seats) {
      if (await isLiveMembership(seat, now)) live.add(seatKey(seat));
    }
    return live;
  },
  /** Cohort roles other than student: `userId:cohortId` to the role. */
  roles: new Map<string, string>(),
  /** Mentorship groups: `userId:cohortId` to the group it holds. */
  groups: new Map<string, string>(),
  failMemberships: false,
  /** Each seat's membership row, as the doors read it. */
  memberships: async (seats: readonly Seat[]) => {
    if (accounts.failMemberships) throw new Error('postgres is down');
    return new Map<string, CohortMembershipFacts>(
      seats.map((seat) => {
        const key = `${seat.userId}:${seat.cohortId}`;
        return [
          seatKey(seat),
          {
            cohortId: seat.cohortId,
            role: accounts.roles.get(key) ?? 'student',
            leftAt: accounts.notMembers.has(key) ? new Date(0) : null,
            status: 'active',
            accessExpiresAt: accounts.visitEnds.get(key) ?? null,
            trackId: null,
            mentorshipGroupId: accounts.groups.get(key) ?? null,
          },
        ];
      }),
    );
  },
  /** The spaces on the map as campus-api has them. See openLibrary. */
  spaces: new Map<string, SpaceFacts>(),
  failSpaces: false,
  spacesOn: async () => {
    if (accounts.failSpaces) throw new Error('postgres is down');
    return new Map(accounts.spaces);
  },
  spaceListeners: [] as (() => void)[],
  onSpacesChanged: async (listener: () => void) => {
    accounts.spaceListeners.push(listener);
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
  load: async (seat: Seat) => {
    store.loads += 1;
    const held = store.heldLoads.get(seat.cohortId);
    if (held) await held;
    if (store.failLoad) throw new Error('redis is down');
    return store.positions.get(positionKey(seat)) as
      | { x: number; y: number; facing: 'up' | 'down' | 'left' | 'right' }
      | undefined;
  },
  save: async (entries: readonly PositionToSave[]) => {
    if (store.failSave) throw new Error('redis is down');
    for (const entry of entries) {
      const { x, y, facing } = entry;
      store.positions.set(positionKey(entry), { x, y, facing });
    }
  },
  forget: async (seat: Seat) => {
    store.positions.delete(positionKey(seat));
  },
  ready: async () => true,
  close: async () => undefined,
};

/** Stands in for presence in Redis, and for the other instances behind it. */
/** One presence entry per account and cohort, as the real stores keep them. */
const presenceKeyOf = ({ userId, cohortId = COHORT }: SeatIn) =>
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
    presence.entries.set(presenceKeyOf(entry), entry);
    return true;
  },
  /** Every change-of-space write, in order: counted apart from renewals. */
  crossings: [] as Presence[],
  /** Connections whose next change of space finds a newer one holding it. */
  newerOnCrossing: new Set<string>(),
  failCrossings: false,
  changeSpace: async (entry: Presence) => {
    presence.crossings.push(entry);
    if (presence.failCrossings) throw new Error('redis is down');
    if (presence.newerOnCrossing.has(entry.connectionId)) return false;
    presence.entries.set(presenceKeyOf(entry), entry);
    return true;
  },
  renew: async (entries: readonly Presence[]) => {
    if (presence.failing) throw new Error('redis is down');
    const displaced: Displacement[] = [];
    for (const entry of entries) {
      if (presence.heldElsewhere.has(entry.connectionId)) {
        displaced.push(entry);
      } else {
        presence.entries.set(presenceKeyOf(entry), entry);
      }
    }
    return displaced;
  },
  leave: async (entries: readonly Presence[]) => {
    for (const entry of entries) {
      const key = presenceKeyOf(entry);
      if (presence.entries.get(key)?.connectionId === entry.connectionId) {
        presence.entries.delete(key);
      }
    }
  },
  setStatus: async (entry: Presence) => {
    if (presence.failing) throw new Error('redis is down');
    const key = presenceKeyOf(entry);
    const held = presence.entries.get(key);
    if (held?.connectionId === entry.connectionId) {
      presence.entries.set(key, { ...held, status: entry.status });
    }
  },
  online: async () => [],
  onlineUserIds: async () => new Set<string>(),
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

/**
 * The library as a normal meeting room, which anybody walks into: how every
 * test finds it unless it says otherwise.
 */
function openLibrary(): void {
  accounts.spaces.clear();
  accounts.spaces.set('library', {
    name: 'Library',
    kind: 'meeting_room',
    access: SPACE_ACCESS.Normal,
    retiredAt: null,
    locked: false,
    grants: [],
  });
}

/** The library designated, with these entries on its list. */
function designateLibrary(...grants: SpaceGrantFacts[]): void {
  accounts.spaces.set('library', {
    name: 'Library',
    kind: 'classroom',
    access: SPACE_ACCESS.Designated,
    retiredAt: null,
    locked: false,
    grants,
  });
}

openLibrary();

/** An entry naming one subject, counting since well before any test. */
function listEntry(subject: Partial<SpaceGrantFacts>): SpaceGrantFacts {
  return {
    toUserId: null,
    toTrackId: null,
    toCohortRole: null,
    toSystemRole: null,
    toGroupId: null,
    validFrom: new Date(0),
    validTo: null,
    ...subject,
  };
}

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
function connect(
  headers: Record<string, string>,
  cohortId = COHORT,
  socketUrl = url,
) {
  const target =
    cohortId === ''
      ? socketUrl
      : `${socketUrl}?cohortId=${encodeURIComponent(cohortId)}`;
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
    ({
      displayName: _name,
      spriteKey: _sprite,
      status: _status,
      spaceKey: _space,
      ...player
    }) => player,
  );
}

beforeEach(async () => {
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
  accounts.roles.clear();
  accounts.groups.clear();
  accounts.failSpaces = false;
  accounts.failMemberships = false;
  openLibrary();
  // A test that changed the doors must not leave them changed for the next.
  await world.gateway.spacesChanged();
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
  world = await buildWorld({
    env,
    accounts,
    positions: store,
    presence,
    map,
  });
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
      awayAfterSeconds: 600,
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
        .poll(() =>
          world.gateway.players.isRemembered({
            userId: REVOKED,
            cohortId: COHORT,
          }),
        )
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
      .poll(() =>
        world.gateway.players.isRemembered({
          userId: 'user-3',
          cohortId: COHORT,
        }),
      )
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

  async function arrive(who = GUEST) {
    const conn = connect({
      origin: ORIGIN,
      cookie: `campus_session=${await token(
        SessionScope.FullAccess,
        SECRET,
        who,
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
    expect(
      world.gateway.players.isRemembered({ userId: GUEST, cohortId: COHORT }),
    ).toBe(true);
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

    const working = accounts.liveMemberships;
    accounts.liveMemberships = async () => {
      throw new Error('database unavailable');
    };
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    accounts.liveMemberships = working;

    expect(conn.ws.readyState).toBe(WebSocket.OPEN);
    conn.ws.close();
    await conn.settled;
  }, 15_000);

  /**
   * The sweep's economy: membership is asked once for every socket together,
   * as the session check beside it asks for every login at once. One query
   * per socket would put the whole campus's worth of queries in the sweep.
   */
  it('asks about every open socket’s membership in one query', async () => {
    // An admin's socket rides along to be left out of the question: their
    // role admits them, so the sweep never asks whether they belong.
    accounts.admins.add('guest-admin');
    const open = await Promise.all([
      arrive(),
      arrive('guest-2'),
      arrive('guest-3'),
      arrive('guest-admin'),
    ]);
    expect(world.gateway.connections.size).toBe(4);

    const asked: Seat[][] = [];
    const working = accounts.liveMemberships;
    accounts.liveMemberships = async (seats, now) => {
      asked.push([...seats]);
      return working(seats, now);
    };
    try {
      // Through at least one sweep.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    } finally {
      accounts.liveMemberships = working;
      // Closed before anything is asserted: a failure left them open, and
      // four open sockets stall every test after this one.
      for (const conn of open) {
        conn.ws.close();
        await conn.settled;
      }
    }

    // Every sweep that ran asked once, and the one question carried every
    // non-admin seat — not one socket's worth at a time.
    expect(asked.length).toBeGreaterThan(0);
    for (const seats of asked) {
      expect(seats.map(seatKey).sort()).toEqual(
        [
          seatKey({ userId: 'guest-1', cohortId: COHORT }),
          seatKey({ userId: 'guest-2', cohortId: COHORT }),
          seatKey({ userId: 'guest-3', cohortId: COHORT }),
        ].sort(),
      );
    }
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

  /** One step, answered, then the walking speed's wait before the next. */
  const step = async (
    conn: ReturnType<typeof connect>,
    direction: string,
    seq: number,
  ) => {
    move(conn, direction, seq);
    const answer = await waitFor(
      conn,
      (m) => m.type === 'moveResult' && m.seq === seq,
    );
    await new Promise((resolve) => setTimeout(resolve, env.WORLD_STEP_MS));
    return answer;
  };

  /** Two steps right of the spawn: beside the library, at (2, 0). */
  const toTheDoor = async (conn: ReturnType<typeof connect>) => {
    await step(conn, 'right', 1);
    await step(conn, 'right', 2);
  };

  /** Three steps right: the last is the one into the library. */
  const walkToLibrary = async (conn: ReturnType<typeof connect>) => {
    await toTheDoor(conn);
    return step(conn, 'right', 3);
  };

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
        status: 'available',
        spaceKey: DEFAULT_SPACE_KEY,
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

    // One more than the burst allows, all at once.
    for (let seq = 0; seq <= STEP_BURST; seq++) move(walker, 'down', seq);
    await waitFor(
      walker,
      (m) => m.type === 'moveResult' && m.seq === STEP_BURST,
    );

    const results = walker.messages.filter((m) => m.type === 'moveResult');
    expect(results.map((m) => m.outcome)).toContain('too_fast');
    // Wherever they ended up, it was not every step away.
    const last = results.at(-1) as { player: { y: number } };
    expect(last.player.y).toBeLessThan(STEP_BURST + 1);

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
    expect(world.gateway.players.has({ userId: ada, cohortId: COHORT })).toBe(
      false,
    );

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
      expect(
        world.gateway.players.get({ userId: ada, cohortId: 'cohort-backend' }),
      ).toMatchObject({
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
      store.positions.set(
        positionKey({ userId: ada, cohortId: 'cohort-backend' }),
        {
          x: 3,
          y: 2,
          facing: 'left',
        },
      );

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
      expect(
        world.gateway.players.get({ userId: ada, cohortId: 'cohort-frontend' }),
      ).toMatchObject({
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
        .poll(() =>
          store.positions.get(
            positionKey({ userId: ada, cohortId: 'cohort-frontend' }),
          ),
        )
        .toEqual({ x: 1, y: 0, facing: 'right' });
      await expect
        .poll(() =>
          store.positions.get(
            positionKey({ userId: ada, cohortId: 'cohort-backend' }),
          ),
        )
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
      expect(
        world.gateway.players.has({ userId: ada, cohortId: 'cohort-backend' }),
      ).toBe(true);
      expect(
        world.gateway.players.isRemembered({
          userId: ada,
          cohortId: 'cohort-frontend',
        }),
      ).toBe(true);

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
        .poll(() =>
          world.gateway.players.isRemembered({
            userId: ada,
            cohortId: 'cohort-frontend',
          }),
        )
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
      expect(world.gateway.players.has({ userId: ada, cohortId: COHORT })).toBe(
        true,
      );
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
      store.positions.set(
        positionKey({ userId: ada, cohortId: 'cohort-backend' }),
        {
          x: 3,
          y: 2,
          facing: 'left',
        },
      );
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
      expect(
        store.positions.get(
          positionKey({ userId: ada, cohortId: 'cohort-backend' }),
        ),
      ).toEqual({
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
      expect(
        world.gateway.players.has({ userId: ada, cohortId: 'cohort-backend' }),
      ).toBe(false);
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
      expect(
        world.gateway.players.get({ userId: ada, cohortId: 'cohort-frontend' }),
      ).toMatchObject({
        x: 1,
        y: 0,
      });

      await leave(inFrontend);
      await leave(inBackend);
    });

    it('places both when two cohorts wait at once, each at its own saved position', async () => {
      const ada = person();
      store.positions.set(
        positionKey({ userId: ada, cohortId: 'cohort-backend' }),
        {
          x: 3,
          y: 2,
          facing: 'left',
        },
      );
      store.positions.set(
        positionKey({ userId: ada, cohortId: 'cohort-frontend' }),
        {
          x: 4,
          y: 1,
          facing: 'right',
        },
      );
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
      expect(
        world.gateway.players.get({ userId: ada, cohortId: 'cohort-backend' }),
      ).toMatchObject({
        x: 3,
        y: 2,
      });
      expect(
        world.gateway.players.get({ userId: ada, cohortId: 'cohort-frontend' }),
      ).toMatchObject({
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
        .poll(() =>
          world.gateway.players.isRemembered({ userId: ada, cohortId: COHORT }),
        )
        .toBe(true);
      await expect
        .poll(() => store.positions.get(positionKey({ userId: ada })))
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
      expect(
        world.gateway.players.isRemembered({ userId: ada, cohortId: COHORT }),
      ).toBe(false);
      await expect
        .poll(() => store.positions.has(positionKey({ userId: ada })))
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
      store.positions.set(
        positionKey({ userId: ada, cohortId: 'cohort-frontend' }),
        {
          x: 1,
          y: 1,
          facing: 'up',
        },
      );
      store.positions.set(
        positionKey({ userId: ada, cohortId: 'cohort-backend' }),
        {
          x: 2,
          y: 2,
          facing: 'down',
        },
      );

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
        .poll(() =>
          store.positions.has(
            positionKey({ userId: ada, cohortId: 'cohort-frontend' }),
          ),
        )
        .toBe(false);
      // The cohort not involved in the attempt is left alone.
      expect(
        store.positions.has(
          positionKey({ userId: ada, cohortId: 'cohort-backend' }),
        ),
      ).toBe(true);
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
    expect(world.gateway.players.has({ userId: ada, cohortId: COHORT })).toBe(
      false,
    );
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
    expect(world.gateway.players.has({ userId: ada, cohortId: COHORT })).toBe(
      false,
    );
    // Access taken away: nothing kept to come back to.
    expect(
      world.gateway.players.isRemembered({ userId: ada, cohortId: COHORT }),
    ).toBe(false);

    await leave(watcher);
  }, 15_000);

  /**
   * Beyond the reconnect grace, where somebody stood is kept in the store
   * (Redis in production) and they start there on their next visit.
   */
  describe('between visits', () => {
    it('starts somebody where they stood last time', async () => {
      const ada = person();
      store.positions.set(positionKey({ userId: ada }), {
        x: 2,
        y: 3,
        facing: 'left',
      });

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
      store.positions.set(positionKey({ userId: ada }), {
        x: 9,
        y: 9,
        facing: 'up',
      });

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
      store.positions.set(positionKey({ userId: ada }), {
        ...WALL,
        facing: 'up',
      });

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
        .poll(() => store.positions.get(positionKey({ userId: ada })))
        .toEqual({ x: 1, y: 0, facing: 'right' });
    });

    it('saves somebody who moved while they are still here', async () => {
      const ada = person();
      const conn = await arrive(ada);
      move(conn, 'down', 1);
      await waitFor(conn, (m) => m.type === 'moveResult');

      await expect
        .poll(() => store.positions.get(positionKey({ userId: ada })), {
          timeout: 3_000,
        })
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
        .poll(() =>
          world.gateway.players.isRemembered({ userId: ada, cohortId: COHORT }),
        )
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
        .poll(() => store.positions.has(positionKey({ userId: ada })), {
          timeout: 3_000,
        })
        .toBe(true);

      accounts.suspended.add(ada);

      await expect(conn.settled).resolves.toMatchObject({ closeCode: 1008 });
      await expect
        .poll(() => store.positions.has(positionKey({ userId: ada })), {
          timeout: 3_000,
        })
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
        .poll(() =>
          presence.entries.get(
            presenceKeyOf({ userId: ada, cohortId: 'cohort-frontend' }),
          ),
        )
        .toMatchObject({ connectionId, cohortId: 'cohort-frontend' });

      await leave(conn);
      await expect
        .poll(() =>
          presence.entries.has(
            presenceKeyOf({ userId: ada, cohortId: 'cohort-frontend' }),
          ),
        )
        .toBe(false);
    });

    /**
     * One move, answered, then a full step's time, so the next has its
     * allowance back. Any shorter and a long walk runs out of steps, sooner
     * the faster the machine answers.
     */
    const crossingsOf = (userId: string) =>
      presence.crossings
        .filter((entry) => entry.userId === userId)
        .map((entry) => entry.spaceKey);

    it('records the space they arrive in', async () => {
      const ada = person();
      const conn = await arrive(ada);

      await expect
        .poll(() => presence.entries.get(presenceKeyOf({ userId: ada })))
        .toMatchObject({ spaceKey: DEFAULT_SPACE_KEY });
      await leave(conn);
    });

    /** Somebody back where they stood last time is in that place's space. */
    it('records the space of a saved position they come back to', async () => {
      const ada = person();
      store.positions.set(positionKey({ userId: ada }), {
        x: 3,
        y: 1,
        facing: 'left',
      });

      const conn = await arrive(ada);

      await expect
        .poll(() => presence.entries.get(presenceKeyOf({ userId: ada })))
        .toMatchObject({ spaceKey: 'library' });
      await leave(conn);
    });

    /** Right the moment they cross; a step within a space costs no write. */
    it('writes the space as they cross into it and out of it, and not for steps within it', async () => {
      const ada = person();
      const conn = await arrive(ada);

      // The third step right is into the library.
      for (const seq of [1, 2, 3]) await step(conn, 'right', seq);
      expect(crossingsOf(ada)).toEqual(['library']);
      expect(
        presence.entries.get(presenceKeyOf({ userId: ada })),
      ).toMatchObject({
        spaceKey: 'library',
      });

      // Further in: still the library, no write.
      await step(conn, 'right', 4);
      await step(conn, 'down', 5);
      expect(crossingsOf(ada)).toEqual(['library']);

      // Back out the way they came.
      await step(conn, 'up', 6);
      await step(conn, 'left', 7);
      await step(conn, 'left', 8);
      expect(crossingsOf(ada)).toEqual(['library', DEFAULT_SPACE_KEY]);

      await leave(conn);
    });

    /** Into a wall, or faster than walking allows: they stay put, so no write. */
    it('writes nothing for a move that goes nowhere', async () => {
      const ada = person();
      const conn = await arrive(ada);

      await step(conn, 'down', 1);
      await expect(step(conn, 'down', 2)).resolves.toMatchObject({
        outcome: 'blocked',
      });

      // Beside the library's door, then out of steps for a moment: the step
      // that would cross is refused, and nothing is written for it.
      await step(conn, 'up', 3);
      await step(conn, 'right', 4);
      await step(conn, 'right', 5);
      // A whole burst against the top edge spends every step there is.
      for (let i = 0; i < STEP_BURST; i += 1) move(conn, 'up', 6 + i);
      const crossing = 6 + STEP_BURST;
      move(conn, 'right', crossing);
      await expect(
        waitFor(conn, (m) => m.type === 'moveResult' && m.seq === crossing),
      ).resolves.toMatchObject({ outcome: 'too_fast' });
      await quiet();

      expect(crossingsOf(ada)).toEqual([]);
      await leave(conn);
    });

    /** A crossing write can be the first to learn the place moved on. */
    it('closes a socket whose change of space finds a newer one holding its place', async () => {
      const ada = person();
      const conn = await arrive(ada);
      presence.newerOnCrossing.add(await connectionIdOf(conn));

      for (const seq of [1, 2]) await step(conn, 'right', seq);
      move(conn, 'right', 3);

      await expect(conn.settled).resolves.toMatchObject({
        closeCode: 4000,
        closeReason: 'entered_elsewhere',
      });
    });

    it('puts a change of space that could not be written right at the next renewal', async () => {
      const ada = person();
      const conn = await arrive(ada);
      presence.failCrossings = true;
      try {
        for (const seq of [1, 2, 3]) await step(conn, 'right', seq);
        expect(crossingsOf(ada)).toEqual(['library']);
        expect(
          presence.entries.get(presenceKeyOf({ userId: ada })),
        ).toMatchObject({
          spaceKey: DEFAULT_SPACE_KEY,
        });

        await expect
          .poll(() => presence.entries.get(presenceKeyOf({ userId: ada })), {
            timeout: 3_000,
          })
          .toMatchObject({ spaceKey: 'library' });
      } finally {
        presence.failCrossings = false;
      }
      await leave(conn);
    });

    it('keeps the replacing socket present once the one it replaced closes', async () => {
      const ada = person();
      const first = await arrive(ada);
      const second = await arrive(ada);
      const connectionId = await connectionIdOf(second);
      await first.settled;

      await quiet();
      expect(
        presence.entries.get(presenceKeyOf({ userId: ada }))?.connectionId,
      ).toBe(connectionId);

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
      expect(world.gateway.players.has({ userId: ada, cohortId: COHORT })).toBe(
        false,
      );

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
      expect(presence.entries.has(presenceKeyOf({ userId: ada }))).toBe(false);
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
      expect(presence.entries.has(presenceKeyOf({ userId: ada }))).toBe(false);

      presence.failing = false;
      await expect
        .poll(() => presence.entries.has(presenceKeyOf({ userId: ada })), {
          timeout: 3_000,
        })
        .toBe(true);
      await leave(conn);
    });
  });

  describe('status', () => {
    const setStatus = (conn: { ws: WebSocket }, status: string) =>
      conn.ws.send(JSON.stringify({ type: 'setStatus', status }));
    const statusesIn = (conn: { messages: Record<string, unknown>[] }) =>
      conn.messages.filter((m) => m.type === 'statusChanged');

    it('starts everybody available', async () => {
      const ada = person();
      const conn = await arrive(ada);

      const snapshot = await waitFor(conn, (m) => m.type === 'snapshot');
      expect(snapshot.players).toEqual([
        expect.objectContaining({ userId: ada, status: 'available' }),
      ]);
      await expect
        .poll(
          () => presence.entries.get(presenceKeyOf({ userId: ada }))?.status,
        )
        .toBe('available');

      await leave(conn);
    });

    it('tells a status chosen to everybody in the cohort, them included, and nobody in another', async () => {
      const ada = person();
      const inFrontend = await arrive(ada, 'cohort-frontend');
      const sameCohort = await arrive(person(), 'cohort-frontend');
      const otherCohort = await arrive(person(), 'cohort-backend');

      setStatus(inFrontend, 'busy');

      const changed = { type: 'statusChanged', userId: ada, status: 'busy' };
      await expect(
        waitFor(sameCohort, (m) => m.type === 'statusChanged'),
      ).resolves.toEqual(changed);
      await expect(
        waitFor(inFrontend, (m) => m.type === 'statusChanged'),
      ).resolves.toEqual(changed);
      await expect
        .poll(
          () =>
            presence.entries.get(
              presenceKeyOf({ userId: ada, cohortId: 'cohort-frontend' }),
            )?.status,
        )
        .toBe('busy');
      await quiet();
      expect(statusesIn(otherCohort)).toEqual([]);

      await leave(inFrontend);
      await leave(sameCohort);
      await leave(otherCohort);
    });

    it('keeps a status to the cohort it was chosen in, for somebody in two', async () => {
      const ada = person();
      const inFrontend = await arrive(ada, 'cohort-frontend');
      const inBackend = await arrive(ada, 'cohort-backend');
      const backendWatcher = await arrive(person(), 'cohort-backend');

      setStatus(inFrontend, 'busy');

      await waitFor(inFrontend, (m) => m.type === 'statusChanged');
      await quiet();
      expect(statusesIn(inBackend)).toEqual([]);
      expect(statusesIn(backendWatcher)).toEqual([]);
      expect(
        presence.entries.get(
          presenceKeyOf({ userId: ada, cohortId: 'cohort-backend' }),
        )?.status,
      ).toBe('available');

      await leave(inFrontend);
      await leave(inBackend);
      await leave(backendWatcher);
    });

    it('sends nothing for choosing the status already shown', async () => {
      const conn = await arrive(person());
      const watcher = await arrive(person());

      setStatus(conn, 'available');

      await quiet();
      expect(statusesIn(watcher)).toEqual([]);
      expect(statusesIn(conn)).toEqual([]);
      await leave(conn);
      await leave(watcher);
    });

    it('shows a later arrival the status as it is now', async () => {
      const ada = person();
      const conn = await arrive(ada);
      setStatus(conn, 'away');
      await waitFor(conn, (m) => m.type === 'statusChanged');

      const later = await arrive(person());

      const snapshot = await waitFor(later, (m) => m.type === 'snapshot');
      expect(snapshot.players).toContainEqual(
        expect.objectContaining({ userId: ada, status: 'away' }),
      );
      await leave(conn);
      await leave(later);
    });

    it('forgets the status once they disconnect', async () => {
      const ada = person();
      const first = await arrive(ada);
      setStatus(first, 'busy');
      await expect
        .poll(
          () => presence.entries.get(presenceKeyOf({ userId: ada }))?.status,
        )
        .toBe('busy');

      await leave(first);
      await expect
        .poll(() => presence.entries.has(presenceKeyOf({ userId: ada })))
        .toBe(false);
      const again = await arrive(ada);

      const snapshot = await waitFor(again, (m) => m.type === 'snapshot');
      expect(snapshot.players).toEqual([
        expect.objectContaining({ userId: ada, status: 'available' }),
      ]);
      await leave(again);
    });

    it('keeps the status chosen in a tab another replaces in the same cohort', async () => {
      const ada = person();
      const watcher = await arrive(person());
      const first = await arrive(ada);
      setStatus(first, 'busy');
      await waitFor(watcher, (m) => m.type === 'statusChanged');

      const second = await arrive(ada);
      await first.settled;

      const snapshot = await waitFor(second, (m) => m.type === 'snapshot');
      expect(snapshot.players).toContainEqual(
        expect.objectContaining({ userId: ada, status: 'busy' }),
      );
      await quiet();
      expect(statusesIn(watcher)).toHaveLength(1);
      await expect
        .poll(
          () => presence.entries.get(presenceKeyOf({ userId: ada }))?.status,
        )
        .toBe('busy');

      await leave(second);
      await leave(watcher);
    });

    it('rejects a status that is not one of the three', async () => {
      const conn = await arrive(person());

      setStatus(conn, 'invisible');

      await expect(
        waitFor(conn, (m) => m.type === 'error'),
      ).resolves.toMatchObject({ code: 'BAD_MESSAGE' });
      await leave(conn);
    });
  });

  describe('where everybody is', () => {
    const spaceChanges = (conn: { messages: Record<string, unknown>[] }) =>
      conn.messages
        .filter((m) => m.type === 'spaceChanged')
        .map(({ userId, spaceKey }) => ({ userId, spaceKey }));

    it('shows the space of everybody in the snapshot and in joined', async () => {
      const ada = person();
      const grace = person();
      store.positions.set(positionKey({ userId: ada }), {
        x: 3,
        y: 1,
        facing: 'left',
      });
      const first = await arrive(ada);
      const second = await arrive(grace);

      const snapshot = await waitFor(second, (m) => m.type === 'snapshot');
      expect(snapshot.players).toContainEqual(
        expect.objectContaining({ userId: ada, spaceKey: 'library' }),
      );
      await expect(
        waitFor(
          first,
          (m) =>
            m.type === 'joined' &&
            (m.player as { userId: string }).userId === grace,
        ),
      ).resolves.toMatchObject({ player: { spaceKey: DEFAULT_SPACE_KEY } });
      await Promise.all([leave(first), leave(second)]);
    });

    it('tells the cohort, the walker included, when somebody steps into another space and out again', async () => {
      const ada = person();
      const walker = await arrive(ada);
      const watcher = await arrive(person());
      const elsewhere = await arrive(person(), 'cohort-frontend');

      for (const seq of [1, 2, 3]) await step(walker, 'right', seq);
      await step(walker, 'down', 4);
      await step(walker, 'left', 5);
      await quiet();

      const expected = [
        { userId: ada, spaceKey: 'library' },
        { userId: ada, spaceKey: DEFAULT_SPACE_KEY },
      ];
      expect(spaceChanges(walker)).toEqual(expected);
      expect(spaceChanges(watcher)).toEqual(expected);
      expect(spaceChanges(elsewhere)).toEqual([]);
      await Promise.all([leave(walker), leave(watcher), leave(elsewhere)]);
    });
  });

  /**
   * Who may step into a space. The library is the one drawn space: three
   * steps right of the spawn. A refusal is answered like a wall, and only a
   * step into another space is asked about.
   */
  describe('the doors', () => {
    it('lets anybody into a normal space', async () => {
      const conn = await arrive(person());

      await expect(walkToLibrary(conn)).resolves.toMatchObject({
        outcome: 'moved',
        player: { x: 3, y: 0 },
      });
      await leave(conn);
    });

    it('refuses a step into a designated space they are not on the list of, turning them to face it', async () => {
      designateLibrary();
      await world.gateway.spacesChanged();
      const conn = await arrive(person());

      await expect(walkToLibrary(conn)).resolves.toMatchObject({
        outcome: 'refused',
        player: { x: 2, y: 0, facing: 'right' },
      });
      await leave(conn);
    });

    it('lets in somebody the list names, by person or by role', async () => {
      const ada = person();
      const grace = person();
      designateLibrary(
        listEntry({ toUserId: ada }),
        listEntry({ toCohortRole: 'mentor' }),
      );
      accounts.roles.set(`${grace}:${COHORT}`, 'mentor');
      await world.gateway.spacesChanged();

      const first = await arrive(ada);
      const second = await arrive(grace);
      const third = await arrive(person());

      await expect(walkToLibrary(first)).resolves.toMatchObject({
        outcome: 'moved',
      });
      await expect(walkToLibrary(second)).resolves.toMatchObject({
        outcome: 'moved',
      });
      await expect(walkToLibrary(third)).resolves.toMatchObject({
        outcome: 'refused',
      });
      await Promise.all([leave(first), leave(second), leave(third)]);
    });

    it('lets in a student and a mentor of the group the list names', async () => {
      const GROUP = 'group-1';
      const student = person();
      const mentor = person();
      accounts.roles.set(`${mentor}:${COHORT}`, 'mentor');
      accounts.groups.set(`${student}:${COHORT}`, GROUP);
      accounts.groups.set(`${mentor}:${COHORT}`, GROUP);
      designateLibrary(listEntry({ toGroupId: GROUP }));
      await world.gateway.spacesChanged();

      const first = await arrive(student);
      const second = await arrive(mentor);
      const third = await arrive(person());

      await expect(walkToLibrary(first)).resolves.toMatchObject({
        outcome: 'moved',
      });
      await expect(walkToLibrary(second)).resolves.toMatchObject({
        outcome: 'moved',
      });
      await expect(walkToLibrary(third)).resolves.toMatchObject({
        outcome: 'refused',
      });
      await Promise.all([leave(first), leave(second), leave(third)]);
    });

    it('lets an admin in, whatever the list says', async () => {
      const ada = person();
      accounts.admins.add(ada);
      designateLibrary();
      await world.gateway.spacesChanged();
      const conn = await arrive(ada);

      await expect(walkToLibrary(conn)).resolves.toMatchObject({
        outcome: 'moved',
      });
      await leave(conn);
    });

    it('opens to somebody the moment campus-api says they are on the list, without a reconnect', async () => {
      const ada = person();
      designateLibrary();
      await world.gateway.spacesChanged();
      const conn = await arrive(ada);
      await expect(walkToLibrary(conn)).resolves.toMatchObject({
        outcome: 'refused',
      });

      designateLibrary(listEntry({ toUserId: ada }));
      for (const listener of accounts.spaceListeners) listener();
      await world.gateway.spacesChanged();

      await expect(step(conn, 'right', 4)).resolves.toMatchObject({
        outcome: 'moved',
      });
      await leave(conn);
    });

    it('leaves somebody already inside where they are, and refuses them once they step out and back', async () => {
      const conn = await arrive(person());
      await walkToLibrary(conn);

      designateLibrary();
      await world.gateway.spacesChanged();

      // Within the library: no door to pass.
      await expect(step(conn, 'down', 4)).resolves.toMatchObject({
        outcome: 'moved',
      });
      await expect(step(conn, 'up', 5)).resolves.toMatchObject({
        outcome: 'moved',
      });
      // Out, then back: a door, and they are not on the list.
      await expect(step(conn, 'left', 6)).resolves.toMatchObject({
        outcome: 'moved',
      });
      await expect(step(conn, 'right', 7)).resolves.toMatchObject({
        outcome: 'refused',
      });
      await leave(conn);
    });

    it('starts somebody at the spawn whose saved place is in a space they may no longer enter', async () => {
      const ada = person();
      store.positions.set(positionKey({ userId: ada }), {
        x: 3,
        y: 1,
        facing: 'left',
      });
      designateLibrary();
      await world.gateway.spacesChanged();

      const conn = await arrive(ada);
      const snapshot = await waitFor(conn, (m) => m.type === 'snapshot');

      expect(positionsIn(snapshot)).toContainEqual(
        expect.objectContaining({ userId: ada, x: 0, y: 0 }),
      );
      await leave(conn);
    });

    it('opens a drawn space the database has no row for to anybody', async () => {
      accounts.spaces.delete('library');
      await world.gateway.spacesChanged();
      const conn = await arrive(person());

      await expect(walkToLibrary(conn)).resolves.toMatchObject({
        outcome: 'moved',
      });
      await leave(conn);
    });

    it('keeps a space with a row but no kind to admins: not set up yet', async () => {
      const admin = person();
      accounts.admins.add(admin);
      accounts.spaces.set('library', {
        kind: null,
        access: SPACE_ACCESS.Designated,
        retiredAt: null,
        locked: false,
        grants: [],
      });
      await world.gateway.spacesChanged();

      const member = await arrive(person());
      const staff = await arrive(admin);

      await expect(walkToLibrary(member)).resolves.toMatchObject({
        outcome: 'refused',
      });
      await expect(walkToLibrary(staff)).resolves.toMatchObject({
        outcome: 'moved',
      });
      await Promise.all([leave(member), leave(staff)]);
    });

    it('keeps the doors as they were when the spaces cannot be read', async () => {
      designateLibrary();
      await world.gateway.spacesChanged();
      accounts.failSpaces = true;
      openLibrary();
      await world.gateway.spacesChanged();

      const conn = await arrive(person());

      await expect(walkToLibrary(conn)).resolves.toMatchObject({
        outcome: 'refused',
      });
      await leave(conn);
    });

    it('keeps a saved place when their membership could not be read', async () => {
      const ada = person();
      store.positions.set(positionKey({ userId: ada }), {
        x: 3,
        y: 1,
        facing: 'left',
      });
      accounts.failMemberships = true;

      const conn = await arrive(ada);
      const snapshot = await waitFor(conn, (m) => m.type === 'snapshot');

      expect(positionsIn(snapshot)).toContainEqual(
        expect.objectContaining({ userId: ada, x: 3, y: 1 }),
      );
      await leave(conn);
    });

    it('keeps every drawn space to admins until the spaces have been read once', async () => {
      const own = await buildWorld({
        env,
        accounts: {
          ...accounts,
          spacesOn: async () => {
            throw new Error('postgres is down');
          },
        },
        positions: store,
        presence: new MemoryPresenceStore(),
        map,
      });
      await own.app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = own.app.server.address() as AddressInfo;
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/socket?cohortId=${COHORT}`,
        {
          headers: {
            origin: ORIGIN,
            cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, person())}`,
          },
        },
      );
      const conn = { messages: [] as Record<string, unknown>[] };
      ws.on('message', (raw) =>
        conn.messages.push(
          JSON.parse(raw.toString()) as Record<string, unknown>,
        ),
      );
      try {
        await waitFor(conn, (m) => m.type === 'snapshot');
        const answers: Record<string, unknown>[] = [];
        for (const seq of [1, 2, 3]) {
          ws.send(JSON.stringify({ type: 'move', direction: 'right', seq }));
          answers.push(
            await waitFor(
              conn,
              (m) => m.type === 'moveResult' && m.seq === seq,
            ),
          );
          await new Promise((resolve) =>
            setTimeout(resolve, env.WORLD_STEP_MS),
          );
        }

        // The corridor is open; the library, unread, is not.
        expect(answers.map((answer) => answer.outcome)).toEqual([
          'moved',
          'moved',
          'refused',
        ]);
      } finally {
        ws.close();
        await own.gateway.stop();
        await own.app.close();
      }
    });

    it('keeps a saved place when the spaces could not be read', async () => {
      const ada = person();
      store.positions.set(positionKey({ userId: ada }), {
        x: 3,
        y: 1,
        facing: 'left',
      });
      const own = await buildWorld({
        env,
        accounts: {
          ...accounts,
          spacesOn: async () => {
            throw new Error('postgres is down');
          },
        },
        positions: store,
        presence: new MemoryPresenceStore(),
        map,
      });
      await own.app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = own.app.server.address() as AddressInfo;
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/socket?cohortId=${COHORT}`,
        {
          headers: {
            origin: ORIGIN,
            cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, ada)}`,
          },
        },
      );
      const conn = { messages: [] as Record<string, unknown>[] };
      ws.on('message', (raw) =>
        conn.messages.push(
          JSON.parse(raw.toString()) as Record<string, unknown>,
        ),
      );
      try {
        const snapshot = await waitFor(conn, (m) => m.type === 'snapshot');

        // Inside the library, unread and so admins only: still where they
        // stood, not at the spawn with their place saved over.
        expect(positionsIn(snapshot)).toContainEqual(
          expect.objectContaining({ userId: ada, x: 3, y: 1 }),
        );
      } finally {
        ws.close();
        await own.gateway.stop();
        await own.app.close();
      }
    });

    it('reads a role that changed at the next heartbeat', async () => {
      const ada = person();
      designateLibrary(listEntry({ toCohortRole: 'professor' }));
      await world.gateway.spacesChanged();
      const conn = await arrive(ada);
      await expect(walkToLibrary(conn)).resolves.toMatchObject({
        outcome: 'refused',
      });

      accounts.roles.set(`${ada}:${COHORT}`, 'professor');
      await expect
        .poll(
          () => world.gateway.connections.forUser(ada)[0]?.membership?.role,
          { timeout: 5_000 },
        )
        .toBe('professor');

      await expect(step(conn, 'right', 4)).resolves.toMatchObject({
        outcome: 'moved',
      });
      await leave(conn);
    });
  });

  /**
   * Locking the library, three steps right of the spawn. Anybody inside may
   * lock or unlock it; while it is locked, a step in is refused, admins
   * excepted, and the lock ends when the last person leaves.
   */
  describe('locks', () => {
    const setLock = (conn: { ws: WebSocket }, locked: boolean) =>
      conn.ws.send(JSON.stringify({ type: 'setLock', locked }));

    const lockChanges = (conn: { messages: Record<string, unknown>[] }) =>
      conn.messages
        .filter((m) => m.type === 'lockChanged')
        .map(({ type: _type, ...change }) => change);

    /** Somebody standing in the library who has locked it. */
    async function lockedInside(userId = person()) {
      const conn = await arrive(userId);
      await walkToLibrary(conn);
      setLock(conn, true);
      await waitFor(conn, (m) => m.type === 'lockChanged');
      return conn;
    }

    it('says in the snapshot which spaces can be locked and which are', async () => {
      const inside = await lockedInside();
      const arriving = await arrive(person());

      await expect(
        waitFor(arriving, (m) => m.type === 'snapshot'),
      ).resolves.toMatchObject({
        lockableSpaces: ['library'],
        lockedSpaces: ['library'],
      });
      await Promise.all([leave(inside), leave(arriving)]);
    });

    it('tells the cohort who locked it, and keeps everybody else out', async () => {
      const ada = person();
      const inside = await arrive(ada);
      const outside = await arrive(person());
      await walkToLibrary(inside);

      setLock(inside, true);

      const change = { spaceKey: 'library', locked: true, userId: ada };
      await waitFor(outside, (m) => m.type === 'lockChanged');
      expect(lockChanges(inside)).toEqual([change]);
      expect(lockChanges(outside)).toEqual([change]);
      await expect(walkToLibrary(outside)).resolves.toMatchObject({
        outcome: 'refused',
        player: { x: 2, y: 0, facing: 'right' },
      });
      await Promise.all([leave(inside), leave(outside)]);
    });

    it('lets an admin past a lock', async () => {
      const admin = person();
      accounts.admins.add(admin);
      const inside = await lockedInside();
      const staff = await arrive(admin);

      await expect(walkToLibrary(staff)).resolves.toMatchObject({
        outcome: 'moved',
      });
      await Promise.all([leave(inside), leave(staff)]);
    });

    it('locks one cohort’s library, not another’s', async () => {
      const inside = await lockedInside();
      const elsewhere = await arrive(person(), 'cohort-frontend');

      await expect(walkToLibrary(elsewhere)).resolves.toMatchObject({
        outcome: 'moved',
      });
      await quiet();
      expect(lockChanges(elsewhere)).toEqual([]);
      await Promise.all([leave(inside), leave(elsewhere)]);
    });

    it('lets a guest inside lock and unlock', async () => {
      const guest = person();
      accounts.roles.set(`${guest}:${COHORT}`, 'guest');
      const conn = await lockedInside(guest);

      setLock(conn, false);
      await waitFor(
        conn,
        (m) => m.type === 'lockChanged' && m.locked === false,
      );

      expect(lockChanges(conn)).toEqual([
        { spaceKey: 'library', locked: true, userId: guest },
        { spaceKey: 'library', locked: false, userId: guest },
      ]);
      await leave(conn);
    });

    it('lets anybody inside unlock it, which lets everybody in again', async () => {
      const grace = person();
      const first = await arrive(person());
      const second = await arrive(grace);
      const outside = await arrive(person());
      await walkToLibrary(first);
      await walkToLibrary(second);
      setLock(first, true);
      await waitFor(outside, (m) => m.type === 'lockChanged');

      setLock(second, false);

      await expect(
        waitFor(outside, (m) => m.type === 'lockChanged' && m.locked === false),
      ).resolves.toMatchObject({ userId: grace });
      await expect(walkToLibrary(outside)).resolves.toMatchObject({
        outcome: 'moved',
      });
      await Promise.all([leave(first), leave(second), leave(outside)]);
    });

    it('says nothing when locking what is locked already', async () => {
      const conn = await lockedInside();

      setLock(conn, true);
      await quiet();

      expect(lockChanges(conn)).toHaveLength(1);
      await leave(conn);
    });

    it('refuses to lock the corridors, leaving the socket open', async () => {
      const conn = await arrive(person());

      setLock(conn, true);

      await expect(
        waitFor(conn, (m) => m.type === 'error'),
      ).resolves.toMatchObject({ code: 'NOT_ALLOWED' });
      await expect(step(conn, 'right', 1)).resolves.toMatchObject({
        outcome: 'moved',
      });
      await leave(conn);
    });

    it('refuses to lock a designated space', async () => {
      const ada = person();
      designateLibrary(listEntry({ toUserId: ada }));
      await world.gateway.spacesChanged();
      const conn = await arrive(ada);
      await walkToLibrary(conn);

      setLock(conn, true);

      await expect(
        waitFor(conn, (m) => m.type === 'error'),
      ).resolves.toMatchObject({ code: 'NOT_ALLOWED' });
      expect(lockChanges(conn)).toEqual([]);
      await leave(conn);
    });

    it('ends the lock when the last person steps out', async () => {
      const inside = await lockedInside();
      const outside = await arrive(person());

      await step(inside, 'left', 4);

      await expect(
        waitFor(outside, (m) => m.type === 'lockChanged'),
      ).resolves.toEqual({
        type: 'lockChanged',
        spaceKey: 'library',
        locked: false,
        userId: null,
      });
      // After the step out, so a client never sees the lock end first.
      expect(
        outside.messages
          .map((m) => m.type)
          .filter((type) => type === 'spaceChanged' || type === 'lockChanged'),
      ).toEqual(['spaceChanged', 'lockChanged']);
      await expect(walkToLibrary(outside)).resolves.toMatchObject({
        outcome: 'moved',
      });
      await Promise.all([leave(inside), leave(outside)]);
    });

    it('keeps the lock while somebody is still inside', async () => {
      const admin = person();
      accounts.admins.add(admin);
      const first = await lockedInside();
      const staff = await arrive(admin);
      await walkToLibrary(staff);

      const outside = await arrive(person());

      await step(first, 'left', 4);

      await expect(walkToLibrary(outside)).resolves.toMatchObject({
        outcome: 'refused',
      });
      expect(lockChanges(staff)).toEqual([]);
      await Promise.all([leave(first), leave(staff), leave(outside)]);
    });

    it('ends the lock when the last person inside disconnects', async () => {
      const inside = await lockedInside();
      const outside = await arrive(person());

      await leave(inside);

      await expect(
        waitFor(outside, (m) => m.type === 'lockChanged' && m.locked === false),
      ).resolves.toMatchObject({ userId: null });
      await leave(outside);
    });

    it('starts somebody at the spawn whose saved place is in a locked space', async () => {
      const ada = person();
      store.positions.set(positionKey({ userId: ada }), {
        x: 3,
        y: 1,
        facing: 'left',
      });
      const inside = await lockedInside();

      const conn = await arrive(ada);
      const snapshot = await waitFor(conn, (m) => m.type === 'snapshot');

      expect(positionsIn(snapshot)).toContainEqual(
        expect.objectContaining({ userId: ada, x: 0, y: 0 }),
      );
      await Promise.all([leave(inside), leave(conn)]);
    });

    it('ends the lock, and tells everybody, when the space can no longer be locked', async () => {
      const ada = person();
      const inside = await lockedInside(ada);

      designateLibrary(listEntry({ toUserId: ada }));
      await world.gateway.spacesChanged();

      await expect(
        waitFor(inside, (m) => m.type === 'lockableSpaces'),
      ).resolves.toEqual({ type: 'lockableSpaces', spaceKeys: [] });
      await expect(
        waitFor(inside, (m) => m.type === 'lockChanged' && m.locked === false),
      ).resolves.toMatchObject({ userId: null });
      await leave(inside);
    });
  });

  describe('space names', () => {
    const renameLibrary = (name: string) => {
      const library = accounts.spaces.get('library');
      if (!library) throw new Error('the library has no row');
      accounts.spaces.set('library', { ...library, name } as SpaceFacts);
    };

    it('names every space in the snapshot, with the key where there is no row', async () => {
      const conn = await arrive(person());

      await expect(
        waitFor(conn, (m) => m.type === 'snapshot'),
      ).resolves.toMatchObject({
        spaces: [
          { spaceKey: DEFAULT_SPACE_KEY, name: DEFAULT_SPACE_KEY },
          { spaceKey: 'library', name: 'Library' },
        ],
      });
      await leave(conn);
    });

    it('tells everybody, in every cohort, when a space is renamed', async () => {
      const here = await arrive(person());
      const there = await arrive(person(), 'cohort-backend');

      renameLibrary('Reading room');
      await world.gateway.spacesChanged();

      const renamed = {
        type: 'spaces',
        spaces: [
          { spaceKey: DEFAULT_SPACE_KEY, name: DEFAULT_SPACE_KEY },
          { spaceKey: 'library', name: 'Reading room' },
        ],
      };
      await expect(waitFor(here, (m) => m.type === 'spaces')).resolves.toEqual(
        renamed,
      );
      await expect(waitFor(there, (m) => m.type === 'spaces')).resolves.toEqual(
        renamed,
      );
      await Promise.all([leave(here), leave(there)]);
    });

    it('says nothing when a reload changes no name', async () => {
      const conn = await arrive(person());

      designateLibrary();
      await world.gateway.spacesChanged();
      conn.ws.send(JSON.stringify({ type: 'ping' }));
      await waitFor(conn, (m) => m.type === 'pong');

      expect(conn.messages.filter((m) => m.type === 'spaces')).toEqual([]);
      await leave(conn);
    });
  });

  /**
   * Asking to enter the library from beside it: two steps right of the
   * spawn, at (2, 0).
   */
  describe('asking to enter', () => {
    const send = (conn: { ws: WebSocket }, message: Record<string, unknown>) =>
      conn.ws.send(JSON.stringify(message));

    const ask = (conn: { ws: WebSocket }) =>
      send(conn, { type: 'requestEntry', spaceKey: 'library' });

    /** The latest request from `userId` that `conn` was sent. */
    const requestIdOf = (
      conn: { messages: Record<string, unknown>[] },
      userId?: string,
    ) => {
      const sent = conn.messages.filter(
        (m) =>
          m.type === 'entryRequested' &&
          (userId === undefined || m.userId === userId),
      );
      const latest = sent.at(-1);
      if (!latest) throw new Error('no request was sent there');
      return latest.requestId as string;
    };

    /** Answers the latest request from `userId` that `source` was sent. */
    const answer = (
      conn: ReturnType<typeof connect>,
      userId: string,
      admit: boolean,
      source: { messages: Record<string, unknown>[] } = conn,
    ) =>
      send(conn, {
        type: 'answerEntryRequest',
        requestId: requestIdOf(source, userId),
        admit,
      });

    /** Withdraws the asker's own latest request. */
    const withdraw = (conn: ReturnType<typeof connect>) =>
      send(conn, {
        type: 'withdrawEntryRequest',
        requestId: requestIdOf(conn),
      });

    const requested = (conn: { messages: Record<string, unknown>[] }) =>
      conn.messages.filter((m) => m.type === 'entryRequested');

    const ended = (conn: { messages: Record<string, unknown>[] }) =>
      waitFor(conn, (m) => m.type === 'entryRequestEnded');

    const refusal = async (conn: { messages: Record<string, unknown>[] }) =>
      (await waitFor(conn, (m) => m.type === 'error')).message;

    /** Somebody standing in the library who has locked it. */
    async function lockedInside(userId = person()) {
      const conn = await arrive(userId);
      await walkToLibrary(conn);
      send(conn, { type: 'setLock', locked: true });
      await waitFor(conn, (m) => m.type === 'lockChanged');
      return conn;
    }

    /** Somebody at the library's door who has asked to come in. */
    async function askingAtTheDoor(userId = person()) {
      const conn = await arrive(userId);
      await toTheDoor(conn);
      ask(conn);
      await waitFor(conn, (m) => m.type === 'entryRequested');
      return conn;
    }

    it('tells the asker and everybody inside, and a yes lets them through', async () => {
      const ada = person();
      const grace = person();
      const inside = await lockedInside(ada);
      const outside = await askingAtTheDoor(grace);

      const sent = await waitFor(inside, (m) => m.type === 'entryRequested');
      const request = {
        type: 'entryRequested',
        requestId: expect.any(String),
        userId: grace,
        spaceKey: 'library',
      };
      expect(sent).toEqual(request);
      // One id for the request, the same to the asker as to those inside.
      expect(requested(outside)).toEqual([
        { ...request, requestId: sent.requestId },
      ]);

      answer(inside, grace, true);

      const admitted = {
        type: 'entryRequestEnded',
        requestId: sent.requestId,
        userId: grace,
        spaceKey: 'library',
        outcome: 'admitted',
        answeredBy: ada,
      };
      await expect(ended(outside)).resolves.toEqual(admitted);
      await expect(ended(inside)).resolves.toEqual(admitted);
      await expect(step(outside, 'right', 3)).resolves.toMatchObject({
        outcome: 'moved',
      });
      await Promise.all([leave(inside), leave(outside)]);
    });

    it('refuses a late answer to a withdrawn request, leaving the new one open', async () => {
      const ada = person();
      const inside = await lockedInside();
      const outside = await askingAtTheDoor(ada);
      await waitFor(inside, (m) => m.type === 'entryRequested');
      const first = requestIdOf(inside, ada);

      withdraw(outside);
      await waitFor(inside, (m) => m.type === 'entryRequestEnded');
      ask(outside);
      await waitFor(inside, () => requested(inside).length === 2);
      const second = requestIdOf(inside, ada);
      expect(second).not.toBe(first);

      send(inside, {
        type: 'answerEntryRequest',
        requestId: first,
        admit: true,
      });
      await expect(refusal(inside)).resolves.toBe(
        'no request here for you to answer',
      );
      send(outside, { type: 'withdrawEntryRequest', requestId: first });
      await expect(refusal(outside)).resolves.toBe(
        'no open request of yours to withdraw',
      );
      await expect(step(outside, 'right', 3)).resolves.toMatchObject({
        outcome: 'refused',
      });

      answer(inside, ada, false);
      await expect(
        waitFor(
          outside,
          (m) => m.type === 'entryRequestEnded' && m.requestId === second,
        ),
      ).resolves.toMatchObject({ outcome: 'declined' });
      await Promise.all([leave(inside), leave(outside)]);
    });

    it('drops a yes once the space opens, so locking it again means asking again', async () => {
      const ada = person();
      const inside = await lockedInside();
      const outside = await askingAtTheDoor(ada);
      answer(inside, ada, true);
      await ended(outside);
      const locks = (locked: boolean) =>
        outside.messages.filter(
          (m) => m.type === 'lockChanged' && m.locked === locked,
        ).length;

      send(inside, { type: 'setLock', locked: false });
      await expect.poll(() => locks(false)).toBe(1);
      send(inside, { type: 'setLock', locked: true });
      // Its first `lockChanged` to lock: the first lock was in its snapshot.
      await expect.poll(() => locks(true)).toBe(1);

      await expect(step(outside, 'right', 3)).resolves.toMatchObject({
        outcome: 'refused',
      });
      await Promise.all([leave(inside), leave(outside)]);
    });

    it('ends a replaced tab’s request at the swap, and leaves the new tab’s alone when the old one closes late', async () => {
      const ada = person();
      const inside = await lockedInside();
      const old = await askingAtTheDoor(ada);
      await waitFor(inside, (m) => m.type === 'entryRequested');
      // Reads nothing, so its close lands late, as a sleeping tab's does.
      old.ws.pause();

      const fresh = await arrive(ada);
      await expect(ended(inside)).resolves.toMatchObject({
        userId: ada,
        outcome: 'withdrawn',
      });
      ask(fresh);
      await waitFor(fresh, (m) => m.type === 'entryRequested');
      await waitFor(inside, () => requested(inside).length === 2);
      old.ws.resume();
      await old.settled;
      await quiet();

      answer(inside, ada, true);

      await expect(
        waitFor(
          fresh,
          (m) => m.type === 'entryRequestEnded' && m.outcome === 'admitted',
        ),
      ).resolves.toMatchObject({ answeredBy: expect.any(String) });
      expect(
        fresh.messages.filter((m) => m.type === 'entryRequestEnded'),
      ).toHaveLength(1);
      expect(
        old.messages.filter((m) => m.type === 'entryRequestEnded'),
      ).toEqual([expect.objectContaining({ outcome: 'withdrawn' })]);
      await expect(step(fresh, 'right', 3)).resolves.toMatchObject({
        outcome: 'moved',
      });
      await Promise.all([leave(inside), leave(fresh)]);
    });

    it('drops a yes when its tab is replaced, so the new tab asks again', async () => {
      const ada = person();
      const inside = await lockedInside();
      const old = await askingAtTheDoor(ada);
      answer(inside, ada, true);
      await ended(old);

      const fresh = await arrive(ada);
      await old.settled;

      await expect(step(fresh, 'right', 3)).resolves.toMatchObject({
        outcome: 'refused',
      });
      await Promise.all([leave(inside), leave(fresh)]);
    });

    it('hands the open requests to the new tab of somebody inside who could answer', async () => {
      const ada = person();
      const grace = person();
      const old = await lockedInside(ada);
      const outside = await askingAtTheDoor(grace);
      await waitFor(old, (m) => m.type === 'entryRequested');

      const fresh = await arrive(ada);
      await old.settled;

      await expect(
        waitFor(fresh, (m) => m.type === 'entryRequested'),
      ).resolves.toMatchObject({ userId: grace });
      answer(fresh, grace, true);
      await expect(ended(outside)).resolves.toMatchObject({
        outcome: 'admitted',
        answeredBy: ada,
      });
      await Promise.all([leave(fresh), leave(outside)]);
    });

    it('lets a yes lapse when they walk away from the door first', async () => {
      const ada = person();
      const inside = await lockedInside();
      const outside = await askingAtTheDoor(ada);
      answer(inside, ada, true);
      await ended(outside);

      await step(outside, 'left', 3);
      await step(outside, 'right', 4);

      await expect(step(outside, 'right', 5)).resolves.toMatchObject({
        outcome: 'refused',
      });
      await Promise.all([leave(inside), leave(outside)]);
    });

    it('keeps them out on a no, and makes them wait to ask again', async () => {
      const ada = person();
      const inside = await lockedInside();
      const outside = await askingAtTheDoor(ada);

      answer(inside, ada, false);

      await expect(ended(outside)).resolves.toMatchObject({
        outcome: 'declined',
      });
      await expect(step(outside, 'right', 3)).resolves.toMatchObject({
        outcome: 'refused',
      });
      ask(outside);
      await expect(refusal(outside)).resolves.toBe(
        'asked again too soon after a no',
      );

      vi.useFakeTimers({
        toFake: ['Date'],
        now: new Date(Date.now() + 30_000),
      });
      ask(outside);
      try {
        await waitFor(outside, () => requested(outside).length === 2);
      } finally {
        vi.useRealTimers();
      }
      await Promise.all([leave(inside), leave(outside)]);
    });

    it('lets the first answer stand', async () => {
      const admin = person();
      accounts.admins.add(admin);
      const ada = person();
      const first = await lockedInside();
      const second = await arrive(admin);
      await walkToLibrary(second);
      const outside = await askingAtTheDoor(ada);
      await waitFor(second, (m) => m.type === 'entryRequested');

      answer(first, ada, false);
      await ended(outside);
      answer(second, ada, true);

      await expect(refusal(second)).resolves.toBe(
        'no request here for you to answer',
      );
      await expect(ended(outside)).resolves.toMatchObject({
        outcome: 'declined',
      });
      await Promise.all([leave(first), leave(second), leave(outside)]);
    });

    it('sends an open request to somebody who steps in later', async () => {
      const admin = person();
      accounts.admins.add(admin);
      const ada = person();
      const inside = await lockedInside();
      const outside = await askingAtTheDoor(ada);
      const staff = await arrive(admin);
      expect(requested(staff)).toEqual([]);

      await walkToLibrary(staff);

      await expect(
        waitFor(staff, (m) => m.type === 'entryRequested'),
      ).resolves.toMatchObject({ userId: ada });
      await Promise.all([leave(inside), leave(outside), leave(staff)]);
    });

    it.each([
      [
        'withdraws it',
        (conn: ReturnType<typeof connect>) => withdraw(conn),
        'withdrawn',
      ],
      [
        'walks away from the door',
        (conn: ReturnType<typeof connect>) => void step(conn, 'left', 3),
        'walked_away',
      ],
    ])(
      'ends it, and tells everybody, when the asker %s',
      async (_, act, outcome) => {
        const inside = await lockedInside();
        const outside = await askingAtTheDoor();
        await waitFor(inside, (m) => m.type === 'entryRequested');

        act(outside);

        await expect(ended(inside)).resolves.toMatchObject({ outcome });
        await expect(ended(outside)).resolves.toMatchObject({ outcome });
        await Promise.all([leave(inside), leave(outside)]);
      },
    );

    it('ends it when the asker disconnects', async () => {
      const inside = await lockedInside();
      const outside = await askingAtTheDoor();
      await waitFor(inside, (m) => m.type === 'entryRequested');

      await leave(outside);

      await expect(ended(inside)).resolves.toMatchObject({
        outcome: 'withdrawn',
      });
      await leave(inside);
    });

    it('ends it as not needed once the space is unlocked', async () => {
      const inside = await lockedInside();
      const outside = await askingAtTheDoor();

      send(inside, { type: 'setLock', locked: false });

      await expect(ended(outside)).resolves.toMatchObject({
        outcome: 'not_needed',
      });
      await expect(step(outside, 'right', 3)).resolves.toMatchObject({
        outcome: 'moved',
      });
      await Promise.all([leave(inside), leave(outside)]);
    });

    it.each([
      [
        'from the corridors',
        async (conn: ReturnType<typeof connect>) => {
          await step(conn, 'right', 1);
        },
        'ask from beside the space',
      ],
      [
        'twice',
        async (conn: ReturnType<typeof connect>) => {
          await toTheDoor(conn);
          ask(conn);
          await waitFor(conn, (m) => m.type === 'entryRequested');
        },
        'you have a request open already',
      ],
    ])('refuses asking %s', async (_, before, message) => {
      const inside = await lockedInside();
      const outside = await arrive(person());
      await before(outside);

      ask(outside);

      await expect(refusal(outside)).resolves.toBe(message);
      await Promise.all([leave(inside), leave(outside)]);
    });

    it('tells somebody asking into the corridors that they may walk in', async () => {
      const conn = await arrive(person());
      await walkToLibrary(conn);

      send(conn, { type: 'requestEntry', spaceKey: DEFAULT_SPACE_KEY });

      await expect(refusal(conn)).resolves.toBe('you may walk in');
      await leave(conn);
    });

    it('refuses asking into a space the map does not draw', async () => {
      const conn = await arrive(person());
      await toTheDoor(conn);

      send(conn, { type: 'requestEntry', spaceKey: 'nowhere' });

      await expect(refusal(conn)).resolves.toBe('no such space');
      await leave(conn);
    });

    it('refuses asking into a space that is open anyway', async () => {
      const conn = await arrive(person());
      await toTheDoor(conn);

      ask(conn);

      await expect(refusal(conn)).resolves.toBe('you may walk in');
      await leave(conn);
    });

    describe('a designated space', () => {
      it('is asked only while somebody on its list is inside', async () => {
        designateLibrary(listEntry({ toCohortRole: 'mentor' }));
        await world.gateway.spacesChanged();
        const conn = await arrive(person());
        await toTheDoor(conn);

        ask(conn);

        await expect(refusal(conn)).resolves.toBe('nobody inside can answer');
        await leave(conn);
      });

      it('is answered by people on its list, never by a visitor let in', async () => {
        const ada = person();
        const grace = person();
        const linus = person();
        designateLibrary(listEntry({ toUserId: ada }));
        await world.gateway.spacesChanged();
        const listed = await arrive(ada);
        await walkToLibrary(listed);

        const visitor = await askingAtTheDoor(grace);
        answer(listed, grace, true);
        await ended(visitor);
        await step(visitor, 'right', 3);

        const next = await askingAtTheDoor(linus);
        await waitFor(listed, () => requested(listed).length === 2);
        expect(requested(visitor)).toEqual([
          expect.objectContaining({ userId: grace }),
        ]);
        answer(visitor, linus, true, listed);
        await expect(refusal(visitor)).resolves.toBe(
          'no request here for you to answer',
        );
        await Promise.all([leave(listed), leave(visitor), leave(next)]);
      });

      it('ends it when the last person who could answer leaves', async () => {
        const ada = person();
        designateLibrary(listEntry({ toUserId: ada }));
        await world.gateway.spacesChanged();
        const listed = await arrive(ada);
        await walkToLibrary(listed);
        const outside = await askingAtTheDoor();

        await step(listed, 'down', 4);
        await step(listed, 'down', 5);

        await expect(ended(outside)).resolves.toMatchObject({
          outcome: 'nobody_inside',
        });
        await Promise.all([leave(listed), leave(outside)]);
      });

      it('ends it as not needed once the list names them', async () => {
        const ada = person();
        const grace = person();
        designateLibrary(listEntry({ toUserId: ada }));
        await world.gateway.spacesChanged();
        const listed = await arrive(ada);
        await walkToLibrary(listed);
        const outside = await askingAtTheDoor(grace);

        designateLibrary(
          listEntry({ toUserId: ada }),
          listEntry({ toUserId: grace }),
        );
        await world.gateway.spacesChanged();

        await expect(ended(outside)).resolves.toMatchObject({
          outcome: 'not_needed',
        });
        await Promise.all([leave(listed), leave(outside)]);
      });
    });
  });

  /**
   * Staff removing somebody from the library, three steps right of the
   * spawn. Removed, they stand at its door, (2, 0), kept out for 90 seconds.
   */
  describe('staff removing somebody', () => {
    const send = (conn: { ws: WebSocket }, message: Record<string, unknown>) =>
      conn.ws.send(JSON.stringify(message));

    const remove = (conn: { ws: WebSocket }, userId: string) =>
      send(conn, { type: 'removeFromSpace', userId });

    const refusal = async (conn: { messages: Record<string, unknown>[] }) =>
      (await waitFor(conn, (m) => m.type === 'error')).message;

    const staffAction = (conn: { messages: Record<string, unknown>[] }) =>
      waitFor(conn, (m) => m.type === 'staffAction');

    /** An admin and somebody else, both in the library. */
    async function adminAndAda() {
      const admin = person();
      accounts.admins.add(admin);
      const ada = person();
      const staff = await arrive(admin);
      const conn = await arrive(ada);
      await walkToLibrary(staff);
      await walkToLibrary(conn);
      return { admin, ada, staff, conn };
    }

    it('moves them to the nearest tile outside, tells them both, and keeps them out', async () => {
      const { admin, ada, staff, conn } = await adminAndAda();

      remove(staff, ada);

      const told = await staffAction(conn);
      expect(told).toEqual({
        type: 'staffAction',
        action: 'removed',
        userId: ada,
        by: admin,
        spaceKey: 'library',
        until: expect.any(String),
        player: { userId: ada, x: 2, y: 0, facing: 'right' },
      });
      await expect(staffAction(staff)).resolves.toEqual(told);
      const until = Date.parse(told.until as string);
      expect(until - Date.now()).toBeGreaterThan(85_000);
      expect(until - Date.now()).toBeLessThanOrEqual(90_000);
      await expect
        .poll(
          () =>
            staff.messages
              .filter((m) => m.type === 'spaceChanged' && m.userId === ada)
              .at(-1)?.spaceKey,
        )
        .toBe(DEFAULT_SPACE_KEY);
      await expect(step(conn, 'right', 4)).resolves.toMatchObject({
        outcome: 'refused',
      });
      await Promise.all([leave(staff), leave(conn)]);
    });

    it('lets them ask to enter, and a yes lets them back in early', async () => {
      const { ada, staff, conn } = await adminAndAda();
      remove(staff, ada);
      await staffAction(conn);

      send(conn, { type: 'requestEntry', spaceKey: 'library' });
      const asked = await waitFor(staff, (m) => m.type === 'entryRequested');
      send(staff, {
        type: 'answerEntryRequest',
        requestId: asked.requestId,
        admit: true,
      });
      await waitFor(conn, (m) => m.type === 'entryRequestEnded');

      await expect(step(conn, 'right', 4)).resolves.toMatchObject({
        outcome: 'moved',
      });
      await Promise.all([leave(staff), leave(conn)]);
    });

    it('lets them walk back in once the 90 seconds are up', async () => {
      const { ada, staff, conn } = await adminAndAda();
      remove(staff, ada);
      await staffAction(conn);

      vi.useFakeTimers({
        toFake: ['Date'],
        now: new Date(Date.now() + 90_000),
      });
      try {
        await expect(step(conn, 'right', 4)).resolves.toMatchObject({
          outcome: 'moved',
        });
      } finally {
        vi.useRealTimers();
      }
      await Promise.all([leave(staff), leave(conn)]);
    });

    it('lets a professor the designated list names remove somebody in it', async () => {
      const professor = person();
      const ada = person();
      accounts.roles.set(`${professor}:${COHORT}`, 'professor');
      designateLibrary(
        listEntry({ toUserId: professor }),
        listEntry({ toUserId: ada }),
      );
      await world.gateway.spacesChanged();
      const staff = await arrive(professor);
      const conn = await arrive(ada);
      await walkToLibrary(staff);
      await walkToLibrary(conn);

      remove(staff, ada);

      await expect(staffAction(conn)).resolves.toMatchObject({
        action: 'removed',
        by: professor,
      });
      await Promise.all([leave(staff), leave(conn)]);
    });

    it.each([
      ['a student', 'student'],
      ['a professor in a normal space', 'professor'],
    ])('refuses %s', async (_, role) => {
      const who = person();
      const ada = person();
      accounts.roles.set(`${who}:${COHORT}`, role);
      const conn = await arrive(who);
      const target = await arrive(ada);
      await walkToLibrary(conn);
      await walkToLibrary(target);

      remove(conn, ada);

      await expect(refusal(conn)).resolves.toBe('you may not remove them');
      await quiet();
      expect(target.messages.some((m) => m.type === 'staffAction')).toBe(false);
      await Promise.all([leave(conn), leave(target)]);
    });

    it('refuses to remove an admin, or yourself', async () => {
      const { admin, staff, conn } = await adminAndAda();
      const other = person();
      accounts.admins.add(other);
      const second = await arrive(other);
      await walkToLibrary(second);

      remove(staff, other);
      await expect(refusal(staff)).resolves.toBe('you may not remove them');
      staff.messages.length = 0;
      remove(staff, admin);
      await expect(refusal(staff)).resolves.toBe('you may not remove them');
      await Promise.all([leave(staff), leave(conn), leave(second)]);
    });

    it('keeps them out from a new tab, and after a reconnect', async () => {
      const { ada, staff, conn } = await adminAndAda();
      remove(staff, ada);
      await staffAction(conn);

      const tab = await arrive(ada);
      await conn.settled;
      await expect(step(tab, 'right', 4)).resolves.toMatchObject({
        outcome: 'refused',
      });
      await leave(tab);

      const back = await arrive(ada);
      await expect(step(back, 'right', 5)).resolves.toMatchObject({
        outcome: 'refused',
      });
      await Promise.all([leave(staff), leave(back)]);
    });

    it('says they are not here once they have gone', async () => {
      const { ada, staff, conn } = await adminAndAda();
      await leave(conn);
      // Once world has let them go: their own close can land first.
      await waitFor(staff, (m) => m.type === 'left' && m.userId === ada);

      remove(staff, ada);

      await expect(refusal(staff)).resolves.toBe('they are not here');
      await leave(staff);
    });

    it('refuses to remove from a space that takes no requests, where they could not ask back in', async () => {
      accounts.spaces.delete('library');
      await world.gateway.spacesChanged();
      const { ada, staff, conn } = await adminAndAda();

      remove(staff, ada);

      await expect(refusal(staff)).resolves.toBe(
        'they cannot be removed from this space',
      );
      await expect(step(conn, 'left', 4)).resolves.toMatchObject({
        outcome: 'moved',
      });
      await expect(step(conn, 'right', 5)).resolves.toMatchObject({
        outcome: 'moved',
      });
      await Promise.all([leave(staff), leave(conn)]);
    });

    it('refuses, and keeps nobody out, when no floor outside can be reached', async () => {
      // The library walled off from the rest of the map.
      const sealed = new Uint8Array(5 * 5);
      for (const tile of [
        { x: 2, y: 0 },
        { x: 2, y: 1 },
        { x: 3, y: 2 },
        { x: 4, y: 2 },
      ]) {
        sealed[tileIndex({ width: 5 }, tile)] = 1;
      }
      const own = await buildWorld({
        env,
        accounts,
        positions: store,
        presence: new MemoryPresenceStore(),
        map: { ...map, grid: { ...map.grid, walls: sealed } },
      });
      await own.app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = own.app.server.address() as AddressInfo;
      const ownUrl = `ws://127.0.0.1:${port}/socket`;
      try {
        const admin = person();
        const ada = person();
        accounts.admins.add(admin);
        store.positions.set(positionKey({ userId: admin }), {
          x: 3,
          y: 0,
          facing: 'down',
        });
        store.positions.set(positionKey({ userId: ada }), {
          x: 4,
          y: 1,
          facing: 'down',
        });
        const open = async (userId: string) => {
          const conn = connect(
            {
              origin: ORIGIN,
              cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, userId)}`,
            },
            COHORT,
            ownUrl,
          );
          await waitFor(conn, (m) => m.type === 'snapshot');
          return conn;
        };
        const staff = await open(admin);
        const conn = await open(ada);

        remove(staff, ada);

        await expect(refusal(staff)).resolves.toBe(
          'nowhere outside to move them',
        );
        await quiet();
        expect(conn.messages.some((m) => m.type === 'staffAction')).toBe(false);
        // Not flagged as removed: they still walk about inside.
        await expect(step(conn, 'up', 4)).resolves.toMatchObject({
          outcome: 'moved',
        });
        await Promise.all([leave(staff), leave(conn)]);
      } finally {
        await own.gateway.stop();
        await own.app.close();
      }
    });

    it('refuses to remove somebody in the corridors', async () => {
      const admin = person();
      accounts.admins.add(admin);
      const ada = person();
      const staff = await arrive(admin);
      const conn = await arrive(ada);

      remove(staff, ada);

      await expect(refusal(staff)).resolves.toBe('they are in no space');
      await Promise.all([leave(staff), leave(conn)]);
    });
  });
});

/**
 * In a world of its own, idle after a second: in the shared one, everybody in
 * every other test would go away under it.
 */
describe('going away while idle', () => {
  const AWAY = { timeout: 5_000 };
  let idle: World;
  let idleUrl: string;
  let nextUser = 0;

  beforeAll(async () => {
    idle = await buildWorld({
      env: { ...env, WORLD_AWAY_AFTER_SECONDS: 1 },
      accounts,
      positions: store,
      presence: new MemoryPresenceStore(),
      map,
    });
    await idle.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = idle.app.server.address() as AddressInfo;
    idleUrl = `ws://127.0.0.1:${port}/socket`;
  });

  afterAll(async () => {
    await idle.gateway.stop();
    await idle.app.close();
  });

  async function arrive(cohortId = COHORT) {
    const userId = `idler-${++nextUser}`;
    const conn = connect(
      {
        origin: ORIGIN,
        cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, userId)}`,
      },
      cohortId,
      idleUrl,
    );
    await waitFor(conn, (m) => m.type === 'snapshot');
    return { ...conn, userId };
  }

  async function leave(...conns: ReturnType<typeof connect>[]) {
    for (const conn of conns) {
      conn.ws.close();
      await conn.settled;
    }
  }

  /** The statuses one person was shown as, in the order they arrived. */
  const statusesOf = (
    conn: { messages: Record<string, unknown>[] },
    userId: string,
  ) =>
    conn.messages
      .filter((m) => m.type === 'statusChanged' && m.userId === userId)
      .map((m) => m.status);

  it('tells each arrival how long they may be idle', async () => {
    const conn = await arrive();

    expect(conn.messages[0]).toMatchObject({
      type: 'welcome',
      awayAfterSeconds: 1,
    });
    await leave(conn);
  });

  it('shows somebody idle as away to their cohort, them included, and back once they move', async () => {
    const ada = await arrive('cohort-frontend');
    const watcher = await arrive('cohort-frontend');
    const elsewhere = await arrive('cohort-backend');

    await expect
      .poll(() => statusesOf(watcher, ada.userId), AWAY)
      .toEqual(['away']);
    expect(statusesOf(ada, ada.userId)).toEqual(['away']);
    await expect
      .poll(async () =>
        (await idle.presence.online('cohort-frontend')).find(
          (entry) => entry.userId === ada.userId,
        ),
      )
      .toMatchObject({ status: 'away' });

    ada.ws.send(JSON.stringify({ type: 'move', direction: 'right', seq: 1 }));

    await expect
      .poll(() => statusesOf(watcher, ada.userId), AWAY)
      .toEqual(['away', 'available']);
    await expect
      .poll(async () =>
        (await idle.presence.online('cohort-frontend')).find(
          (entry) => entry.userId === ada.userId,
        ),
      )
      .toMatchObject({ status: 'available' });
    expect(statusesOf(elsewhere, ada.userId)).toEqual([]);

    await leave(ada, watcher, elsewhere);
  });

  it('brings them back to the status they chose on `active`', async () => {
    const ada = await arrive();
    const watcher = await arrive();
    ada.ws.send(JSON.stringify({ type: 'setStatus', status: 'busy' }));

    await expect
      .poll(() => statusesOf(watcher, ada.userId), AWAY)
      .toEqual(['busy', 'away']);

    ada.ws.send(JSON.stringify({ type: 'active' }));

    await expect
      .poll(() => statusesOf(watcher, ada.userId), AWAY)
      .toEqual(['busy', 'away', 'busy']);
    await leave(ada, watcher);
  });

  it('does not count a ping as activity', async () => {
    const ada = await arrive();
    const watcher = await arrive();
    const pinging = setInterval(
      () => ada.ws.send(JSON.stringify({ type: 'ping' })),
      100,
    );

    try {
      await expect
        .poll(() => statusesOf(watcher, ada.userId), AWAY)
        .toEqual(['away']);
    } finally {
      clearInterval(pinging);
    }
    await leave(ada, watcher);
  });

  it('brings back an idle tab replaced by a new one in the same cohort', async () => {
    const ada = await arrive();
    const watcher = await arrive();
    ada.ws.send(JSON.stringify({ type: 'setStatus', status: 'busy' }));
    await expect
      .poll(() => statusesOf(watcher, ada.userId), AWAY)
      .toEqual(['busy', 'away']);

    const second = connect(
      {
        origin: ORIGIN,
        cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, ada.userId)}`,
      },
      COHORT,
      idleUrl,
    );
    const snapshot = await waitFor(second, (m) => m.type === 'snapshot');

    expect(second.messages[0]).toMatchObject({ type: 'welcome' });
    expect(snapshot.players).toContainEqual(
      expect.objectContaining({ userId: ada.userId, status: 'busy' }),
    );
    await expect
      .poll(() => statusesOf(watcher, ada.userId))
      .toEqual(['busy', 'away', 'busy']);
    await ada.settled;
    await leave(second, watcher);
  });
});

/** A redeploy must not send everybody back to the spawn. */
describe('shutdown', () => {
  it('saves everybody still here and takes them out of presence before closing their sockets', async () => {
    const saved = new Map<string, unknown>();
    const own = await buildWorld({
      env,
      accounts,
      positions: {
        ...store,
        save: async (players) => {
          for (const { userId, x, y, facing } of players)
            saved.set(userId, { x, y, facing });
        },
      },
      presence: new MemoryPresenceStore(),
      map,
    });
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

  /**
   * Shutdown takes everybody out of presence before it closes their sockets,
   * and their moves are still read meanwhile. One that crosses into another
   * space then must not write their entry back, or they show online for a
   * whole presence lifetime with nothing left to remove them.
   */
  it('does not put back a presence entry for a move made while shutting down', async () => {
    const memory = new MemoryPresenceStore();
    const removed = deferred<void>();
    const release = deferred<void>();
    const holding = {
      instanceId: memory.instanceId,
      enter: (entry: Presence) => memory.enter(entry),
      renew: (entries: readonly Presence[]) => memory.renew(entries),
      changeSpace: (entry: Presence) => memory.changeSpace(entry),
      setStatus: (entry: Presence) => memory.setStatus(entry),
      online: (cohortId: string) => memory.online(cohortId),
      onDisplaced: () => undefined,
      close: async () => undefined,
      // Removed at once, as Redis would, but answered only when let go.
      leave: async (entries: readonly Presence[]) => {
        await memory.leave(entries);
        removed.resolve();
        await release.promise;
      },
    };
    const own = await buildWorld({
      env,
      accounts,
      positions: store,
      presence: holding,
      map,
    });
    await own.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = own.app.server.address() as AddressInfo;
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/socket?cohortId=${COHORT}`,
      {
        headers: {
          origin: ORIGIN,
          cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, `leaving-${randomUUID()}`)}`,
        },
      },
    );
    const messages: Record<string, unknown>[] = [];
    ws.on('message', (raw) =>
      messages.push(JSON.parse(raw.toString()) as Record<string, unknown>),
    );
    const closed = new Promise((resolve) => ws.on('close', resolve));
    const answered = (seq: number) =>
      expect
        .poll(() =>
          messages.some((m) => m.type === 'moveResult' && m.seq === seq),
        )
        .toBe(true);
    await expect
      .poll(() => messages.some((m) => m.type === 'snapshot'))
      .toBe(true);
    for (const seq of [1, 2]) {
      ws.send(JSON.stringify({ type: 'move', direction: 'right', seq }));
      await answered(seq);
      await new Promise((resolve) => setTimeout(resolve, env.WORLD_STEP_MS));
    }

    const stopped = own.gateway.stop();
    await removed.promise;
    // Into the library, while shutdown's removal is still being answered.
    ws.send(JSON.stringify({ type: 'move', direction: 'right', seq: 3 }));
    await answered(3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release.resolve();
    await stopped;

    await expect(memory.online(COHORT)).resolves.toEqual([]);
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
    const own = await buildWorld({
      env: shared,
      accounts,
      positions: store,
    });
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
    expect(first.gateway.players.has({ userId, cohortId })).toBe(false);
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
