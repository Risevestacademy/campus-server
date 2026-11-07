import { DEFAULT_SPACE_KEY } from '@campus/session';
import {} from '@campus/space-access';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import {} from '../infra/presence.js';

import {
  COHORT,
  accounts,
  arrive,
  connect,
  designateLibrary,
  leave,
  listEntry,
  person,
  quiet,
  step,
  toTheDoor,
  useWorld,
  waitFor,
  walkToLibrary,
  world,
} from './gateway.testing.js';

useWorld();

describe('movement', () => {
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
      expect(accounts.answered.filter((a) => a.askerId === grace)).toEqual([
        {
          requestId: sent.requestId,
          askerId: grace,
          admitted: true,
          cohortId: COHORT,
          spaceKey: 'library',
        },
      ]);
      // Written, then pushed to the asker on this cohort's socket alone.
      await expect(
        waitFor(outside, (m) => m.type === 'notification'),
      ).resolves.toEqual({
        type: 'notification',
        id: expect.any(String),
        kind: 'entry_request_admitted',
        referenceType: 'entry_request',
        referenceId: sent.requestId,
        context: { cohortId: COHORT, spaceKey: 'library' },
        createdAt: expect.any(String),
      });
      expect(inside.messages.some((m) => m.type === 'notification')).toBe(
        false,
      );
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
      // The withdrawn request and the refused late answer notify nobody.
      expect(accounts.answered.filter((a) => a.askerId === ada)).toEqual([
        {
          requestId: second,
          askerId: ada,
          admitted: false,
          cohortId: COHORT,
          spaceKey: 'library',
        },
      ]);
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
});
