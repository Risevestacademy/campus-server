import { signSessionToken, SessionScope } from '@campus/session';
import {} from '@campus/space-access';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { seatKey, type Seat } from '../seat.js';
import {} from '../infra/presence.js';

import {
  COHORT,
  ORIGIN,
  SECRET,
  accounts,
  connect,
  deferred,
  token,
  useWorld,
  world,
} from './gateway.testing.js';

useWorld();

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
