import { signSessionToken, SessionScope } from '@campus/session';
import type { AddressInfo } from 'node:net';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import WebSocket from 'ws';

import { buildWorld, type World } from '../app.js';
import { oneAtATime } from './gateway.js';
import { loadEnv } from '../infra/env.js';

const SECRET = 'a-world-session-secret-of-at-least-32-chars';
const ORIGIN = 'https://campus.example.com';

/** Answers for the database, so these tests need none. */
const accounts = {
  suspended: new Set<string>(),
  gone: new Set<string>(),
  /** Logins signed out, revoked or no longer refreshed. Every other one is live. */
  endedSessions: new Set<string>(),
  /** `userId:cohortId` pairs with no live membership. Everything else has one. */
  notMembers: new Set<string>(),
  admins: new Set<string>(),
  find: async (userId: string) =>
    accounts.gone.has(userId)
      ? null
      : {
          id: userId,
          suspended: accounts.suspended.has(userId),
          admin: accounts.admins.has(userId),
        },
  liveSessions: async (ids: readonly string[]): Promise<Set<string>> =>
    new Set(ids.filter((id) => !accounts.endedSessions.has(id))),
  liveMembership: async (userId: string, cohortId: string): Promise<boolean> =>
    !accounts.notMembers.has(`${userId}:${cohortId}`),
  close: async () => undefined,
};

/** Stands in for Redis: where each person last stood, kept between visits. */
const store = {
  positions: new Map<string, { x: number; y: number; facing: string }>(),
  failLoad: false,
  loads: 0,
  load: async (userId: string) => {
    store.loads += 1;
    if (store.failLoad) throw new Error('redis is down');
    return store.positions.get(userId) as
      | { x: number; y: number; facing: 'up' | 'down' | 'left' | 'right' }
      | undefined;
  },
  save: async (
    players: readonly {
      userId: string;
      x: number;
      y: number;
      facing: string;
    }[],
  ) => {
    for (const { userId, x, y, facing } of players) {
      store.positions.set(userId, { x, y, facing });
    }
  },
  forget: async (userId: string) => {
    store.positions.delete(userId);
  },
  ready: async () => true,
  close: async () => undefined,
};

const env = loadEnv({
  AUTH_SESSION_SECRET: SECRET,
  DATABASE_URL: 'postgres://unused',
  CORS_ORIGINS: `${ORIGIN},http://localhost:3000`,
  WORLD_HEARTBEAT_SECONDS: '1',
  WORLD_MAX_MESSAGE_BYTES: '256',
  // Small, with spawn in a corner, so an edge is one step away.
  WORLD_MAP_WIDTH: '5',
  WORLD_MAP_HEIGHT: '5',
  WORLD_SPAWN_X: '0',
  WORLD_SPAWN_Y: '0',
  // Long enough that steps sent together reliably land in one tick.
  WORLD_TICK_MS: '200',
  // The shortest allowed, so a periodic save lands within a test.
  WORLD_POSITION_SAVE_SECONDS: '1',
  FF_LOG_LEVEL: 'fatal',
} as NodeJS.ProcessEnv);

let world: World;
let url: string;

async function token(
  scope: SessionScope = SessionScope.FullAccess,
  secret = SECRET,
  userId = 'user-1',
): Promise<string> {
  const { token } = await signSessionToken(
    { userId, email: `${userId}@campus.local`, scope },
    { secret, ttlMinutes: 30 },
  );
  return token;
}

const COHORT = 'cohort-1';

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

beforeEach(() => {
  accounts.suspended.clear();
  accounts.gone.clear();
  accounts.endedSessions.clear();
  accounts.notMembers.clear();
  accounts.admins.clear();
  store.positions.clear();
  store.failLoad = false;
  store.loads = 0;
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
  world = await buildWorld(env, accounts, store);
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
      .poll(() => world.gateway.players.isRemembered('user-3'))
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
    expect(world.gateway.connections.forUser('user-1')).toBeDefined();

    conn.ws.close();
    await conn.settled;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(world.gateway.connections.size).toBe(0);
  });

  it('replaces the socket a person already had open', async () => {
    const one = await open();
    const two = await open();

    await one.settled;
    expect(world.gateway.connections.forUser('user-1')).toBeDefined();
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
    expect(snapshot).toMatchObject({ map: { width: 5, height: 5 } });
    expect(snapshot.players).toEqual(
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
      player: { userId: grace, x: 0, y: 0, facing: 'down' },
    });
    // Learns about themselves from the snapshot, not from a joined.
    await quiet();
    expect(second.messages.some((m) => m.type === 'joined')).toBe(false);

    await leave(first);
    await leave(second);
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
    expect(world.gateway.players.has(ada)).toBe(false);

    await leave(staying);
  });

  /** One cohort, one device, one tab: the newest connection wins. */
  describe('one place at a time', () => {
    const entryOf = (message: Record<string, unknown>) =>
      message.player as { userId: string; x: number; y: number };

    it('holds one socket for the account, however many were opened', async () => {
      const ada = person();
      const first = await arrive(ada);
      const second = await arrive(ada);
      const third = await arrive(ada);
      await first.settled;
      await second.settled;

      expect(
        world.gateway.connections.all().filter((c) => c.userId === ada),
      ).toHaveLength(1);
      expect(world.gateway.connections.forUser(ada)).toBeDefined();
      expect(
        world.gateway.players.all().filter((p) => p.userId === ada),
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
      expect(snapshot.players).toContainEqual({
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

    it('leaves the old cohort and joins the new, keeping the position', async () => {
      const ada = person();
      const watcher = await arrive(person());
      const inFrontend = await arrive(ada, 'cohort-frontend');
      move(inFrontend, 'right', 1);
      await waitFor(inFrontend, (m) => m.type === 'moveResult');

      const inBackend = await arrive(ada, 'cohort-backend');

      await expect(
        waitFor(watcher, (m) => m.type === 'left' && m.userId === ada),
      ).resolves.toBeDefined();
      await expect(
        waitFor(
          watcher,
          (m) =>
            m.type === 'joined' &&
            entryOf(m).userId === ada &&
            entryOf(m).x === 1,
        ),
      ).resolves.toMatchObject({ player: { userId: ada, x: 1, y: 0 } });

      expect(world.gateway.connections.forUser(ada)?.cohortId).toBe(
        'cohort-backend',
      );

      await leave(inBackend);
      await leave(watcher);
    });

    it('keeps the avatar until the surviving socket closes', async () => {
      const ada = person();
      const watcher = await arrive(person());
      const first = await arrive(ada);
      const second = await arrive(ada);
      await first.settled;

      await quiet();
      expect(world.gateway.players.has(ada)).toBe(true);
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
      expect(snapshot.players).toContainEqual({
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
        .poll(() => world.gateway.players.isRemembered(ada))
        .toBe(true);

      accounts.suspended.add(ada);
      const refused = connect({
        origin: ORIGIN,
        cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, ada)}`,
      });
      await expect(refused.first).resolves.toMatchObject({
        message: 'account_suspended',
      });
      await refused.settled;
      expect(world.gateway.players.isRemembered(ada)).toBe(false);

      // Suspension lifted: welcome back, but at the spawn.
      accounts.suspended.delete(ada);
      const again = await arrive(ada);
      const snapshot = await waitFor(again, (m) => m.type === 'snapshot');
      expect(snapshot.players).toContainEqual({
        userId: ada,
        x: 0,
        y: 0,
        facing: 'down',
      });
      await leave(again);
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
    expect(world.gateway.players.has(ada)).toBe(false);
    expect(world.gateway.connections.forUser(ada)).toBeUndefined();

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
    expect(world.gateway.players.has(ada)).toBe(false);
    // Access taken away: nothing kept to come back to.
    expect(world.gateway.players.isRemembered(ada)).toBe(false);

    await leave(watcher);
  }, 15_000);

  /**
   * Beyond the reconnect grace, where somebody stood is kept in the store
   * (Redis in production) and they start there on their next visit.
   */
  describe('between visits', () => {
    it('starts somebody where they stood last time', async () => {
      const ada = person();
      store.positions.set(ada, { x: 2, y: 3, facing: 'left' });

      const conn = await arrive(ada);

      const snapshot = await waitFor(conn, (m) => m.type === 'snapshot');
      expect(snapshot.players).toContainEqual({
        userId: ada,
        x: 2,
        y: 3,
        facing: 'left',
      });
      await leave(conn);
    });

    it('starts at the spawn when the saved tile is no longer on the map', async () => {
      const ada = person();
      store.positions.set(ada, { x: 9, y: 9, facing: 'up' });

      const conn = await arrive(ada);

      const snapshot = await waitFor(conn, (m) => m.type === 'snapshot');
      expect(snapshot.players).toContainEqual({
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
      expect(snapshot.players).toContainEqual({
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
        .poll(() => store.positions.get(ada))
        .toEqual({ x: 1, y: 0, facing: 'right' });
    });

    it('saves somebody who moved while they are still here', async () => {
      const ada = person();
      const conn = await arrive(ada);
      move(conn, 'down', 1);
      await waitFor(conn, (m) => m.type === 'moveResult');

      await expect
        .poll(() => store.positions.get(ada), { timeout: 3_000 })
        .toEqual({ x: 0, y: 1, facing: 'down' });
      await leave(conn);
    });

    /** The grace in memory is fresher than the store, and costs no round trip. */
    it('does not ask the store when reconnecting within the grace', async () => {
      const ada = person();
      await leave(await arrive(ada));
      await expect
        .poll(() => world.gateway.players.isRemembered(ada))
        .toBe(true);
      const loadsBefore = store.loads;

      const again = await arrive(ada);

      expect(store.loads).toBe(loadsBefore);
      await leave(again);
    });

    it('forgets the saved position when access is taken away', async () => {
      const ada = person();
      const conn = await arrive(ada);
      move(conn, 'right', 1);
      await waitFor(conn, (m) => m.type === 'moveResult');
      await expect
        .poll(() => store.positions.has(ada), { timeout: 3_000 })
        .toBe(true);

      accounts.suspended.add(ada);

      await expect(conn.settled).resolves.toMatchObject({ closeCode: 1008 });
      await expect.poll(() => store.positions.has(ada)).toBe(false);
    }, 15_000);
  });
});

/** A redeploy must not send everybody back to the spawn. */
describe('shutdown', () => {
  it('saves everybody still here before closing their sockets', async () => {
    const saved = new Map<string, unknown>();
    const own = await buildWorld(env, accounts, {
      ...store,
      save: async (players) => {
        for (const { userId, x, y, facing } of players)
          saved.set(userId, { x, y, facing });
      },
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

    await own.gateway.stop();

    expect(saved.get('leaving-1')).toEqual({ x: 0, y: 0, facing: 'down' });
    await closed;
    await own.app.close();
  });
});
