import { DEFAULT_SPACE_KEY, SessionScope } from '@campus/session';
import { SPACE_ACCESS, type SpaceFacts } from '@campus/space-access';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { buildWorld } from '../app.js';
import { MemoryPresenceStore } from '../infra/presence.js';

import {
  COHORT,
  ORIGIN,
  SECRET,
  accounts,
  arrive,
  designateLibrary,
  env,
  leave,
  listEntry,
  map,
  openLibrary,
  person,
  positionKey,
  positionsIn,
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

  describe('desks', () => {
    const desksChanged = (cohortId: string | null) => {
      for (const listener of accounts.deskListeners) listener(cohortId);
    };

    it('tells the people in the cohort campus-api names, and nobody else', async () => {
      const here = await arrive(person());
      const there = await arrive(person(), 'cohort-backend');

      desksChanged(COHORT);

      await expect(
        waitFor(here, (m) => m.type === 'desksChanged'),
      ).resolves.toEqual({ type: 'desksChanged' });
      there.ws.send(JSON.stringify({ type: 'ping' }));
      await waitFor(there, (m) => m.type === 'pong');
      expect(there.messages.filter((m) => m.type === 'desksChanged')).toEqual(
        [],
      );
      await Promise.all([leave(here), leave(there)]);
    });

    it('tells everybody when no cohort is named', async () => {
      const here = await arrive(person());
      const there = await arrive(person(), 'cohort-backend');

      desksChanged(null);

      await expect(
        waitFor(here, (m) => m.type === 'desksChanged'),
      ).resolves.toBeDefined();
      await expect(
        waitFor(there, (m) => m.type === 'desksChanged'),
      ).resolves.toBeDefined();
      await Promise.all([leave(here), leave(there)]);
    });
  });
});
