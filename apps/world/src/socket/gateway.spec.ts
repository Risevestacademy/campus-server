import { signSessionToken, SessionScope } from '@campus/session';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  FF_LOG_LEVEL: 'fatal',
} as NodeJS.ProcessEnv);

let world: World;
let url: string;

async function token(
  scope: SessionScope = SessionScope.FullAccess,
  secret = SECRET,
): Promise<string> {
  const { token } = await signSessionToken(
    { userId: 'user-1', email: 'ada@campus.local', scope },
    { secret, ttlMinutes: 30 },
  );
  return token;
}

/** Opens a socket and collects what the server says, until it closes or settles. */
function connect(headers: Record<string, string>) {
  const ws = new WebSocket(url, { headers });
  const messages: Record<string, unknown>[] = [];

  const settled = new Promise<{ closeCode?: number }>((resolve) => {
    ws.on('message', (raw) => {
      messages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
    ws.on('close', (code) => resolve({ closeCode: code }));
    ws.on('error', () => undefined);
  });

  const first = new Promise<Record<string, unknown>>((resolve) => {
    ws.on('message', (raw) =>
      resolve(JSON.parse(raw.toString()) as Record<string, unknown>),
    );
  });

  return { ws, messages, settled, first };
}

beforeEach(() => {
  accounts.suspended.clear();
  accounts.gone.clear();
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
      for (let i = 0; i < 5; i++) {
        ws.send(JSON.stringify({ type: 'echo', text: `frame-${i}` }));
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 500));
    ws.close();

    // Every frame answered, and in the order it was sent.
    expect(replies.filter((r) => r.type === 'echo').map((r) => r.text)).toEqual([
      'frame-0',
      'frame-1',
      'frame-2',
      'frame-3',
      'frame-4',
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

    conn.ws.send(JSON.stringify({ type: 'echo', text: 'x'.repeat(5_000) }));

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
    await conn.first;
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

  it('echoes, which is the round trip standing in for movement', async () => {
    const conn = await open();

    await expect(reply(conn, { type: 'echo', text: 'hello' })).resolves.toEqual({
      type: 'echo',
      text: 'hello',
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
