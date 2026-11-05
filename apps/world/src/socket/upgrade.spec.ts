import { signSessionToken, SessionScope } from '@campus/session';
import {} from '@campus/space-access';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import {} from '../infra/presence.js';

import {
  COHORT,
  ORIGIN,
  SECRET,
  accounts,
  connect,
  token,
  url,
  useWorld,
  waitFor,
  world,
} from './gateway.testing.js';

useWorld();

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
