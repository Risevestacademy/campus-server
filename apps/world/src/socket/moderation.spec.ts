import { DEFAULT_SPACE_KEY, SessionScope } from '@campus/session';
import {} from '@campus/space-access';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { buildWorld } from '../app.js';
import { tileIndex } from '../movement/grid.js';
import { MemoryPresenceStore } from '../infra/presence.js';

import {
  COHORT,
  ORIGIN,
  SECRET,
  accounts,
  arrive,
  connect,
  designateLibrary,
  env,
  leave,
  listEntry,
  map,
  person,
  positionKey,
  quiet,
  step,
  store,
  token,
  useWorld,
  waitFor,
  walkToLibrary,
  world,
} from './gateway.testing.js';

useWorld();

describe('movement', () => {
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
