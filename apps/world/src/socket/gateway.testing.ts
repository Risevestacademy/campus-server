import { signSessionToken, SessionScope } from '@campus/session';
import {
  SPACE_ACCESS,
  type CohortMembershipFacts,
  type SpaceFacts,
  type SpaceGrantFacts,
} from '@campus/space-access';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import WebSocket from 'ws';

import { buildWorld, type World } from '../app.js';
import { loadEnv } from '../infra/env.js';
import type { RoomLinkPass } from '../infra/accounts.js';
import type { PositionToSave } from '../infra/positions.js';
import { tileIndex } from '../movement/grid.js';
import { spaceIndexFrom } from '../movement/spaces.js';
import type { WorldMap } from '../movement/world-map.js';
import { seatKey, type Seat } from '../seat.js';
import {
  type Displacement,
  type Presence,
  type PresenceEntry,
} from '../infra/presence.js';

export const SECRET = 'a-world-session-secret-of-at-least-32-chars';
export const ORIGIN = 'https://campus.example.com';
export const COHORT = 'cohort-1';

/** A seat in the tests' own cohort unless another is named. */
export type SeatIn = Pick<Seat, 'userId'> & Partial<Seat>;

/** How the fake store keys a position: by account and cohort. */
export const positionKey = ({ userId, cohortId = COHORT }: SeatIn) =>
  `${userId}:${cohortId}`;

/** As the database's own question: is this membership live at `now`? */
export const isLiveMembership = async (
  { userId, cohortId }: Seat,
  now: Date,
) => {
  const key = `${userId}:${cohortId}`;
  if (accounts.notMembers.has(key)) return false;
  const ends = accounts.visitEnds.get(key);
  return ends === undefined || ends > now;
};

/** Answers for the database, so these tests need none. */
export const accounts = {
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
  passes: [] as RoomLinkPass[],
  roomLinkPassesOn: async () => accounts.passes,
  spaceListeners: [] as (() => void)[],
  onSpacesChanged: async (listener: () => void) => {
    accounts.spaceListeners.push(listener);
  },
  deskListeners: [] as ((cohortId: string | null) => void)[],
  onDesksChanged: async (listener: (cohortId: string | null) => void) => {
    accounts.deskListeners.push(listener);
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
export const store = {
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
export const presenceKeyOf = ({ userId, cohortId = COHORT }: SeatIn) =>
  `${userId}:${cohortId}`;

export const presence = {
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
  /** Connections held by other instances, as `online` reads them. */
  onOtherInstances: [] as PresenceEntry[],
  online: async (cohortId: string) =>
    presence.onOtherInstances.filter((entry) => entry.cohortId === cohortId),
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

export const env = loadEnv({
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
export const WALL = { x: 0, y: 2 };
export const walls = new Uint8Array(5 * 5);
walls[tileIndex({ width: 5 }, WALL)] = 1;
export const map: WorldMap = {
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
export function openLibrary(): void {
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
export function designateLibrary(...grants: SpaceGrantFacts[]): void {
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
export function listEntry(subject: Partial<SpaceGrantFacts>): SpaceGrantFacts {
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

export let world: World;
export let url: string;

export async function token(
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
export function connect(
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
export async function waitFor(
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
export function positionsIn(snapshot: Record<string, unknown>) {
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

/** A promise and the hands to settle it, for calls that must stay in flight. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export let nextUser = 0;
/** A fresh person per test, so nobody starts where an earlier test left them. */
export const person = () => `walker-${++nextUser}`;

export async function arrive(userId: string, cohortId = COHORT) {
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

export async function leave(conn: ReturnType<typeof connect>) {
  conn.ws.close();
  await conn.settled;
}

export const move = (conn: { ws: WebSocket }, direction: string, seq: number) =>
  conn.ws.send(JSON.stringify({ type: 'move', direction, seq }));

/** Long enough that anything the server was going to send has arrived. */
export const quiet = () => new Promise((resolve) => setTimeout(resolve, 150));

/** One step, answered, then the walking speed's wait before the next. */
export const step = async (
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
export const toTheDoor = async (conn: ReturnType<typeof connect>) => {
  await step(conn, 'right', 1);
  await step(conn, 'right', 2);
};

/** Three steps right: the last is the one into the library. */
export const walkToLibrary = async (conn: ReturnType<typeof connect>) => {
  await toTheDoor(conn);
  return step(conn, 'right', 3);
};

export function useWorld(): void {
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
    accounts.passes = [];
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
}
