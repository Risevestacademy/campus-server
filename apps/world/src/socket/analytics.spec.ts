import { SessionScope } from '@campus/session';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';

import { EVENTS } from '@campus/analytics';

import { Status } from '../status/availability.js';
import { presenceEndOf } from './features/analytics.js';
import {
  COHORT,
  LIBRARY_ID,
  ORIGIN,
  SECRET,
  accounts,
  analytics,
  arrive,
  connect,
  designateLibrary,
  leave,
  person,
  quiet,
  step,
  toTheDoor,
  token,
  url,
  useWorld,
  waitFor,
  walkToLibrary,
  world,
} from './gateway.testing.js';
import { EntryRequestOutcome, WalkEndReason } from './protocol.js';

useWorld();

const send = (conn: { ws: WebSocket }, message: Record<string, unknown>) =>
  conn.ws.send(JSON.stringify(message));

const named = (event: string) =>
  analytics.events.filter((captured) => captured.event === event);

/** Moves the clock the events read, and nothing else: the sockets keep real timers. */
function later(ms: number): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + ms);
}

describe('analytics', () => {
  afterEach(() => {
    expect(analytics.dropped).toEqual([]);
  });

  describe('presence', () => {
    it('counts a visit to the campus from start to end, under nobody without consent', async () => {
      const ada = person();
      const conn = await arrive(ada);
      await leave(conn);
      await quiet();

      const [started] = named('presence.started');
      const [ended] = named('presence.ended');
      expect(started.properties).toMatchObject({
        client: 'web',
        reconnect: false,
        mode: 'avatar',
        cohort_id: COHORT,
        $process_person_profile: false,
      });
      expect(ended.properties).toMatchObject({
        client: 'web',
        mode: 'avatar',
        reason: 'closed',
        duration_s: expect.any(Number),
      });
      // One stand-in for the whole socket, and never their id.
      expect(started.distinctId).not.toBe(ada);
      expect(ended.distinctId).toBe(started.distinctId);
    });

    it('names them once they have granted consent', async () => {
      const ada = randomUUID();
      accounts.consenting.add(ada);
      const conn = await arrive(ada);
      await leave(conn);
      await quiet();

      expect(named('presence.started')[0].distinctId).toBe(ada);
      expect(
        named('presence.started')[0].properties.$process_person_profile,
      ).toBeUndefined();
    });

    it('takes the app’s word for which app it is', async () => {
      const conn = connect(
        {
          origin: ORIGIN,
          cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, person())}`,
        },
        '',
        `${url}?cohortId=${COHORT}&client=mobile`,
      );
      await waitFor(conn, (m) => m.type === 'snapshot');
      await leave(conn);

      expect(named('presence.started')[0].properties.client).toBe('mobile');
    });

    it('counts a socket replaced by another tab as replaced', async () => {
      const ada = person();
      const first = await arrive(ada);
      const second = await arrive(ada);
      await first.settled;
      await leave(second);
      await quiet();

      expect(named('presence.ended').map((e) => e.properties.reason)).toEqual([
        'replaced',
        'closed',
      ]);
      expect(named('presence.started')[1].properties.reconnect).toBe(true);
    });

    it('says why a socket ended from what closed it', () => {
      expect(presenceEndOf('server shutting down', 1001)).toBe('shutdown');
      expect(presenceEndOf('session_revoked', 1008)).toBe('signed_out');
      expect(presenceEndOf('not_a_member', 1008)).toBe('access_ended');
      expect(presenceEndOf(undefined, 1006)).toBe('lost');
      expect(presenceEndOf(undefined, 1000)).toBe('closed');
      expect(presenceEndOf('rate_limited', 1008)).toBe('error');
    });
  });

  describe('spaces', () => {
    it('counts a visit once they leave, with how they came and how much they said', async () => {
      const conn = await arrive(person());
      await walkToLibrary(conn);
      send(conn, { type: 'say', text: 'morning' });
      await waitFor(conn, (m) => m.type === 'said');
      later(12_000);
      await step(conn, 'left', 4);

      expect(named('space.visited').map((e) => e.properties)).toEqual([
        expect.objectContaining({
          space_id: LIBRARY_ID,
          space_kind: 'meeting_room',
          access: 'normal',
          audio_mode: 'boundary',
          duration_s: 12,
          arrived_by: 'step',
          lines_said: 1,
          cohort_id: COHORT,
        }),
      ]);
      await leave(conn);
    });

    it('does not count walking through', async () => {
      const conn = await arrive(person());
      await walkToLibrary(conn);
      await step(conn, 'left', 4);
      await leave(conn);
      await quiet();

      expect(named('space.visited')).toEqual([]);
    });

    it('counts a visit still going when the socket closes', async () => {
      const conn = await arrive(person());
      await walkToLibrary(conn);
      later(30_000);
      await leave(conn);
      await quiet();

      expect(named('space.visited')).toHaveLength(1);
    });

    it('counts a refused step once a minute, with why', async () => {
      designateLibrary();
      await world.gateway.spacesChanged();
      const conn = await arrive(person());
      await walkToLibrary(conn);
      await step(conn, 'right', 4);

      expect(named('space.refused').map((e) => e.properties)).toEqual([
        expect.objectContaining({
          space_id: LIBRARY_ID,
          space_kind: 'classroom',
          reason: 'designated',
          may_ask: false,
        }),
      ]);

      later(61_000);
      await step(conn, 'right', 5);
      expect(named('space.refused')).toHaveLength(2);
      await leave(conn);
    });

    it('counts a walk into a space, and the visit it began', async () => {
      const conn = await arrive(person());
      send(conn, { type: 'goToSpace', spaceKey: 'library' });
      await waitFor(conn, (m) => m.type === 'walkEnded');

      expect(named('walk.ended').map((e) => e.properties)).toEqual([
        expect.objectContaining({
          target: 'space',
          reason: 'arrived',
          steps: expect.any(Number),
        }),
      ]);

      later(15_000);
      await step(conn, 'left', 1);
      expect(named('space.visited')[0].properties.arrived_by).toBe(
        'go_to_space',
      );
      await leave(conn);
    });

    it('counts a lock and an unlock, with how many were inside', async () => {
      const conn = await arrive(person());
      await walkToLibrary(conn);
      send(conn, { type: 'setLock', locked: true });
      await waitFor(conn, (m) => m.type === 'lockChanged' && m.locked === true);
      send(conn, { type: 'setLock', locked: false });
      await waitFor(
        conn,
        (m) => m.type === 'lockChanged' && m.locked === false,
      );

      expect(named('space.lock_changed').map((e) => e.properties)).toEqual([
        expect.objectContaining({ locked: true, occupants: 1 }),
        expect.objectContaining({ locked: false, occupants: 1 }),
      ]);
      await leave(conn);
    });

    it('counts a request to enter once it ends, under the asker, with why they asked', async () => {
      const inside = await arrive(person());
      await walkToLibrary(inside);
      send(inside, { type: 'setLock', locked: true });
      await waitFor(inside, (m) => m.type === 'lockChanged');
      const outside = await arrive(person());
      await toTheDoor(outside);
      send(outside, { type: 'requestEntry', spaceKey: 'library' });
      const asked = await waitFor(inside, (m) => m.type === 'entryRequested');

      send(inside, {
        type: 'answerEntryRequest',
        requestId: asked.requestId,
        admit: false,
      });
      await waitFor(outside, (m) => m.type === 'entryRequestEnded');

      expect(named('entry.request_ended').map((e) => e.properties)).toEqual([
        expect.objectContaining({
          space_id: LIBRARY_ID,
          reason: 'locked',
          outcome: 'declined',
          wait_s: 0,
        }),
      ]);
      await leave(outside);
      await leave(inside);
    });

    it('counts a removal under the staff member, naming nobody', async () => {
      const admin = randomUUID();
      accounts.admins.add(admin);
      const ada = person();
      const staff = await arrive(admin);
      const conn = await arrive(ada);
      await walkToLibrary(staff);
      await walkToLibrary(conn);

      send(staff, { type: 'removeFromSpace', userId: ada });
      await waitFor(conn, (m) => m.type === 'staffAction');

      const [acted] = named('staff.acted');
      expect(acted.distinctId).toBe(admin);
      expect(acted.properties).toMatchObject({
        action: 'removed',
        space_kind: 'meeting_room',
        actor_role: 'admin',
      });
      expect(JSON.stringify(acted)).not.toContain(ada);
      await leave(conn);
      await leave(staff);
    });
  });

  describe('status', () => {
    it('counts a status they chose, and whether it was for a while', async () => {
      const conn = await arrive(person());
      send(conn, { type: 'setStatus', status: 'busy', forSeconds: 600 });
      await waitFor(conn, (m) => m.type === 'statusChanged');

      expect(named('status.chosen').map((e) => e.properties)).toEqual([
        expect.objectContaining({ status: 'busy', timed: true }),
      ]);
      await leave(conn);
    });
  });

  describe("the package's lists against world's", () => {
    it.each(Object.values(Status))('admits the status %s', (status) => {
      expect(
        EVENTS['status.chosen'].schema.safeParse({ status, timed: false })
          .success,
      ).toBe(true);
    });

    it.each(WalkEndReason.options)('admits the walk end %s', (reason) => {
      expect(
        EVENTS['walk.ended'].schema.safeParse({
          target: 'person',
          reason,
          steps: 0,
        }).success,
      ).toBe(true);
    });

    it.each(EntryRequestOutcome.options)(
      'admits the request outcome %s',
      (outcome) => {
        expect(
          EVENTS['entry.request_ended'].schema.safeParse({
            space_id: LIBRARY_ID,
            space_kind: 'open',
            reason: 'locked',
            outcome,
            wait_s: 0,
          }).success,
        ).toBe(true);
      },
    );
  });
});
