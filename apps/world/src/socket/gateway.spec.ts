import { signSessionToken, SessionScope } from '@campus/session';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { buildWorld, type World } from '../app.js';
import { loadEnv } from '../infra/env.js';

const SECRET = 'a-world-session-secret-of-at-least-32-chars';
const ORIGIN = 'https://campus.example.com';

/** Answers for the database, so these tests need none. */
const accounts = {
  suspended: new Set<string>(),
  gone: new Set<string>(),
  find: async (userId: string) =>
    accounts.gone.has(userId)
      ? null
      : { id: userId, suspended: accounts.suspended.has(userId) },
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

/** Opens a socket and collects what the server says, until it closes or settles. */
function connect(headers: Record<string, string>) {
  const ws = new WebSocket(url, { headers });
  const messages: Record<string, unknown>[] = [];

  const settled = new Promise<{ closeCode?: number; closeReason?: string }>((resolve) => {
    ws.on('message', (raw) => {
      messages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
    ws.on('close', (code, reason) =>
      resolve({ closeCode: code, closeReason: reason.toString() }),
    );
    ws.on('error', () => undefined);
  });

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
      throw new Error(`test left ${world.gateway.connections.size} socket(s) open`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});

beforeAll(async () => {
  world = await buildWorld(env, accounts);
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

  it('refuses a cookie sent with no origin at all', async () => {
    const { first } = connect({ cookie: `campus_session=${await token()}` });

    await expect(first).resolves.toMatchObject({ message: 'origin_not_allowed' });
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
    const { first } = connect({ origin: ORIGIN, cookie: `campus_session=${foreign}` });

    await expect(first).resolves.toMatchObject({ message: 'token_not_usable' });
  });

  it('refuses a session whose account has been suspended', async () => {
    accounts.suspended.add('user-1');
    const { first } = connect({
      origin: ORIGIN,
      cookie: `campus_session=${await token()}`,
    });

    await expect(first).resolves.toMatchObject({ message: 'account_suspended' });
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
    const ws = new WebSocket(url, {
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
    expect(replies.filter((r) => r.type === 'moveResult').map((r) => r.seq)).toEqual([
      0, 1, 2, 3, 4,
    ]);
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
      { userId: 'user-2', email: 'grace@campus.local', scope: SessionScope.FullAccess },
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

describe('an open socket', () => {
  async function open() {
    const conn = connect({ origin: ORIGIN, cookie: `campus_session=${await token()}` });
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

    await expect(reply(conn, { type: 'ping' })).resolves.toEqual({ type: 'pong' });
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

    await expect(reply(conn, { type: 'teleport', to: 'anywhere' })).resolves.toMatchObject(
      { code: 'BAD_MESSAGE' },
    );
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

  it('holds both tabs a person has open', async () => {
    const one = await open();
    const two = await open();

    expect(world.gateway.connections.forUser('user-1')).toHaveLength(2);
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

  async function arrive(userId: string) {
    const conn = connect({
      origin: ORIGIN,
      cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, userId)}`,
    });
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

    await expect(waitFor(walker, (m) => m.type === 'moveResult')).resolves.toEqual({
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

    await expect(waitFor(walker, (m) => m.type === 'moveResult')).resolves.toMatchObject({
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

    for (let i = 0; i < 200; i++) flooder.ws.send(JSON.stringify({ type: 'ping' }));

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

    await expect(waitFor(walker, (m) => m.type === 'error')).resolves.toMatchObject({
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

  /**
   * Two tabs are one person in one place: the second must not announce a
   * second arrival, and closing one must not make them vanish.
   */
  describe('somebody with two tabs', () => {
    it('is one player, not two', async () => {
      const ada = person();
      const watcher = await arrive(person());
      const tabOne = await arrive(ada);
      const tabTwo = await arrive(ada);

      await quiet();
      expect(watcher.messages.filter((m) => m.type === 'joined')).toHaveLength(1);
      expect(world.gateway.players.all().filter((p) => p.userId === ada)).toHaveLength(1);

      await leave(tabOne);
      await leave(tabTwo);
      await leave(watcher);
    });

    it('walks the same avatar from either tab, and both follow along', async () => {
      const ada = person();
      const tabOne = await arrive(ada);
      const tabTwo = await arrive(ada);

      move(tabOne, 'right', 1);

      await expect(waitFor(tabTwo, (m) => m.type === 'moved')).resolves.toMatchObject({
        players: [{ userId: ada, x: 1, y: 0 }],
      });

      move(tabTwo, 'down', 1);
      await expect(waitFor(tabTwo, (m) => m.type === 'moveResult')).resolves.toMatchObject({
        player: { x: 1, y: 1 },
      });

      await leave(tabOne);
      await leave(tabTwo);
    });

    /**
     * Tab one's last answer is its own step; tab two's step came after it.
     * If the tick leaves out every tab that moved, tab one never learns
     * where the avatar ended up.
     */
    it('brings both tabs to the final position when both step inside one tick', async () => {
      const ada = person();
      const tabOne = await arrive(ada);
      const tabTwo = await arrive(ada);

      move(tabOne, 'right', 1);
      move(tabTwo, 'down', 1);
      await waitFor(tabTwo, (m) => m.type === 'moveResult');

      await expect(
        waitFor(
          tabOne,
          (m) =>
            m.type === 'moved' &&
            (m.players as { userId: string; x: number; y: number }[]).some(
              (p) => p.userId === ada && p.x === 1 && p.y === 1,
            ),
        ),
      ).resolves.toBeDefined();

      await leave(tabOne);
      await leave(tabTwo);
    });

    it('stays while either tab is open, and leaves with the last', async () => {
      const ada = person();
      const watcher = await arrive(person());
      const tabOne = await arrive(ada);
      const tabTwo = await arrive(ada);

      await leave(tabOne);
      await quiet();
      expect(watcher.messages.some((m) => m.type === 'left')).toBe(false);
      expect(world.gateway.players.has(ada)).toBe(true);

      await leave(tabTwo);
      await expect(waitFor(watcher, (m) => m.type === 'left')).resolves.toEqual({
        type: 'left',
        userId: ada,
      });

      await leave(watcher);
    });
  });

  /** Whichever way a socket is dropped, its player must not be left standing. */
  it('removes the player when a suspension closes their socket', async () => {
    const ada = person();
    const conn = await arrive(ada);
    const watcher = await arrive(person());

    accounts.suspended.add(ada);

    await expect(conn.settled).resolves.toMatchObject({ closeCode: 1008 });
    await expect(waitFor(watcher, (m) => m.type === 'left')).resolves.toMatchObject({
      userId: ada,
    });
    expect(world.gateway.players.has(ada)).toBe(false);

    await leave(watcher);
  }, 15_000);
});
