import { DEFAULT_SPACE_KEY, SessionScope } from '@campus/session';
import { SPACE_ACCESS, type SpaceFacts } from '@campus/space-access';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { buildWorld } from '../app.js';
import { CLOSES } from './protocol.js';
import { tileIndex } from '../movement/grid.js';
import { spaceIndexFrom } from '../movement/spaces.js';
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
  map,
  move,
  person,
  positionKey,
  presence,
  quiet,
  store,
  token,
  useWorld,
  waitFor,
  walkToLibrary,
  world,
} from './gateway.testing.js';

useWorld();

describe('movement', () => {
  /** Walking somebody to somebody else, a step per stepMs. */
  describe('going to somebody', () => {
    const send = (conn: { ws: WebSocket }, message: Record<string, unknown>) =>
      conn.ws.send(JSON.stringify(message));

    const goTo = (conn: { ws: WebSocket }, userId: string) =>
      send(conn, { type: 'goTo', userId });

    const walkEnded = (conn: { messages: Record<string, unknown>[] }) =>
      waitFor(conn, (m) => m.type === 'walkEnded');

    const apart = (player: unknown, tile: { x: number; y: number }) => {
      const { x, y } = player as { x: number; y: number };
      return Math.abs(x - tile.x) + Math.abs(y - tile.y);
    };

    /** Somebody else, standing in the library at (3, 0). */
    async function inTheLibrary() {
      const userId = person();
      const conn = await arrive(userId);
      await walkToLibrary(conn);
      return { userId, conn };
    }

    it('walks them into the space, to a tile next to the person, and the cohort sees the walk', async () => {
      const ada = person();
      const walker = await arrive(ada);
      const grace = await inTheLibrary();

      goTo(walker, grace.userId);

      const ended = await walkEnded(walker);
      expect(ended).toMatchObject({
        userId: grace.userId,
        reason: 'arrived',
        spaceKey: null,
      });
      expect(apart(ended.player, { x: 3, y: 0 })).toBe(1);
      expect(walker.messages.filter((m) => m.type === 'walking')).toHaveLength(
        4,
      );
      await expect(
        waitFor(
          grace.conn,
          (m) =>
            m.type === 'spaceChanged' &&
            m.userId === ada &&
            m.spaceKey === 'library',
        ),
      ).resolves.toBeDefined();
      await Promise.all([leave(walker), leave(grace.conn)]);
    });

    it('stops beside a space closed to them, where they can ask to enter', async () => {
      const walker = await arrive(person());
      const grace = await inTheLibrary();
      send(grace.conn, { type: 'setLock', locked: true });
      await waitFor(walker, (m) => m.type === 'lockChanged');

      goTo(walker, grace.userId);

      const ended = await walkEnded(walker);
      expect(ended).toMatchObject({
        reason: 'refused',
        spaceKey: 'library',
        mayAsk: true,
      });
      expect(ended.player).toMatchObject({ x: 2 });
      send(walker, { type: 'requestEntry', spaceKey: 'library' });
      await expect(
        waitFor(grace.conn, (m) => m.type === 'entryRequested'),
      ).resolves.toBeDefined();
      await Promise.all([leave(walker), leave(grace.conn)]);
    });

    it('follows somebody who moves while they walk', async () => {
      const walker = await arrive(person());
      const grace = await inTheLibrary();

      goTo(walker, grace.userId);
      await waitFor(walker, (m) => m.type === 'walking');
      move(grace.conn, 'down', 4);

      const ended = await walkEnded(walker);
      expect(ended).toMatchObject({ reason: 'arrived' });
      expect(apart(ended.player, { x: 3, y: 1 })).toBe(1);
      await Promise.all([leave(walker), leave(grace.conn)]);
    });

    it('ends the first walk when a second replaces it', async () => {
      const walker = await arrive(person());
      const grace = await inTheLibrary();
      const ada = person();
      const other = await arrive(ada);

      goTo(walker, grace.userId);
      goTo(walker, ada);

      await expect(walkEnded(walker)).resolves.toMatchObject({
        userId: grace.userId,
        reason: 'stopped',
      });
      await expect(
        waitFor(walker, (m) => m.type === 'walkEnded' && m.userId === ada),
      ).resolves.toMatchObject({ reason: 'arrived' });
      await Promise.all([leave(walker), leave(grace.conn), leave(other)]);
    });

    /**
     * A 5 × 5 world of its own, spawn at (0, 0), for a layout the shared map
     * does not have. `open` places somebody by their saved position.
     */
    async function ownWorld(
      spaces: {
        key: string;
        access: string;
        x: number;
        y: number;
        width: number;
        height: number;
      }[],
      {
        walls = [],
        stepMs = env.WORLD_STEP_MS,
        walkMaxSteps,
      }: {
        walls?: { x: number; y: number }[];
        stepMs?: number;
        walkMaxSteps?: number;
      } = {},
    ) {
      const grid = new Uint8Array(5 * 5);
      for (const wall of walls) grid[tileIndex({ width: 5 }, wall)] = 1;
      const own = await buildWorld({
        env: {
          ...env,
          WORLD_STEP_MS: stepMs,
          WORLD_WALK_MAX_STEPS: walkMaxSteps,
        },
        accounts: {
          ...accounts,
          spacesOn: async () =>
            new Map<string, SpaceFacts>(
              spaces.map(({ key, access }) => [
                key,
                {
                  kind:
                    access === SPACE_ACCESS.Designated
                      ? 'classroom'
                      : 'meeting_room',
                  access,
                  retiredAt: null,
                  locked: false,
                  grants: [],
                },
              ]),
            ),
        },
        positions: store,
        presence: new MemoryPresenceStore(),
        map: {
          ...map,
          grid: { width: 5, height: 5, spawn: { x: 0, y: 0 }, walls: grid },
          spaces: spaceIndexFrom({
            widthTiles: 5,
            heightTiles: 5,
            collisions: [],
            spawn: { x: 0, y: 0 },
            spaces: spaces.map(({ key, x, y, width, height }) => ({
              key,
              name: key,
              kind: null,
              bounds: { shape: 'rect', x, y, width, height },
              properties: {},
            })),
            portals: [],
            desks: [],
          }),
        },
      });
      await own.app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = own.app.server.address() as AddressInfo;
      const sockets: WebSocket[] = [];
      const open = async (userId: string, at?: { x: number; y: number }) => {
        if (at) {
          store.positions.set(positionKey({ userId }), {
            ...at,
            facing: 'down',
          });
        }
        const ws = new WebSocket(
          `ws://127.0.0.1:${port}/socket?cohortId=${COHORT}`,
          {
            headers: {
              origin: ORIGIN,
              cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, userId)}`,
            },
          },
        );
        sockets.push(ws);
        const conn = {
          ws,
          messages: [] as Record<string, unknown>[],
          closed: new Promise<number>((resolve) =>
            ws.once('close', (code) => resolve(code)),
          ),
        };
        ws.on('message', (raw) =>
          conn.messages.push(
            JSON.parse(raw.toString()) as Record<string, unknown>,
          ),
        );
        await waitFor(conn, (m) => m.type === 'snapshot');
        return conn;
      };
      const close = async () => {
        for (const ws of sockets) ws.close();
        await own.gateway.stop();
        await own.app.close();
      };
      return { open, close, gateway: own.gateway };
    }

    /**
     * A booth at (3, 2) and (3, 3) inside a hall (x 2 to 4) designated for
     * nobody.
     */
    const hallWithBooth = (boothAccess: string) =>
      ownWorld([
        {
          key: 'hall',
          access: SPACE_ACCESS.Designated,
          x: 2,
          y: 0,
          width: 3,
          height: 5,
        },
        { key: 'booth', access: boothAccess, x: 3, y: 2, width: 1, height: 2 },
      ]);

    it('stops beside a closed space in the way, though theirs is open', async () => {
      const own = await hallWithBooth(SPACE_ACCESS.Normal);
      try {
        const admin = person();
        accounts.admins.add(admin);
        await own.open(admin, { x: 3, y: 2 });
        const walker = await own.open(person());

        goTo(walker, admin);

        await expect(walkEnded(walker)).resolves.toMatchObject({
          reason: 'refused',
          spaceKey: 'hall',
          player: { x: 1, y: 0 },
        });
      } finally {
        await own.close();
      }
    });

    it('stops at the first closed space in the way when theirs is closed too', async () => {
      const own = await hallWithBooth(SPACE_ACCESS.Designated);
      try {
        const admin = person();
        accounts.admins.add(admin);
        await own.open(admin, { x: 3, y: 2 });
        const walker = await own.open(person());

        goTo(walker, admin);

        await expect(walkEnded(walker)).resolves.toMatchObject({
          reason: 'refused',
          spaceKey: 'hall',
          player: { x: 1, y: 0 },
        });
      } finally {
        await own.close();
      }
    });

    it('steps off their tile rather than arrive on it', async () => {
      const walker = await arrive(person());
      const grace = person();
      const graceConn = await arrive(grace);

      goTo(walker, grace);

      const ended = await walkEnded(walker);
      expect(ended).toMatchObject({ reason: 'arrived' });
      expect(apart(ended.player, { x: 0, y: 0 })).toBe(1);
      expect(walker.messages.filter((m) => m.type === 'walking')).toHaveLength(
        1,
      );
      await Promise.all([leave(walker), leave(graceConn)]);
    });

    it('says there is no way when their space has no room beside them', async () => {
      const own = await ownWorld([
        {
          key: 'booth',
          access: SPACE_ACCESS.Normal,
          x: 2,
          y: 2,
          width: 1,
          height: 1,
        },
      ]);
      try {
        const grace = person();
        await own.open(grace, { x: 2, y: 2 });
        const walker = await own.open(person());

        goTo(walker, grace);

        await expect(walkEnded(walker)).resolves.toMatchObject({
          reason: 'no_way',
          player: { x: 0, y: 0 },
        });
      } finally {
        await own.close();
      }
    });

    it('says there is no way when walls shut them in', async () => {
      const own = await ownWorld([], {
        walls: [
          { x: 3, y: 4 },
          { x: 4, y: 3 },
        ],
      });
      try {
        const grace = person();
        await own.open(grace, { x: 4, y: 4 });
        const walker = await own.open(person());

        goTo(walker, grace);

        await expect(walkEnded(walker)).resolves.toMatchObject({
          reason: 'no_way',
          player: { x: 0, y: 0 },
        });
      } finally {
        await own.close();
      }
    });

    it('ends when staff remove them from a space mid-walk', async () => {
      // A room over all but the right-hand column; slow steps, so the
      // removal lands between two of them.
      const own = await ownWorld(
        [
          {
            key: 'room',
            access: SPACE_ACCESS.Normal,
            x: 0,
            y: 0,
            width: 4,
            height: 5,
          },
        ],
        { stepMs: 500 },
      );
      try {
        const admin = person();
        accounts.admins.add(admin);
        const staff = await own.open(admin, { x: 3, y: 4 });
        const ada = person();
        const walker = await own.open(ada);

        goTo(walker, admin);
        await waitFor(walker, (m) => m.type === 'walking');
        send(staff, { type: 'removeFromSpace', userId: ada });

        await expect(walkEnded(walker)).resolves.toMatchObject({
          reason: 'moved_by_staff',
          player: { x: 4 },
        });
      } finally {
        await own.close();
      }
    });

    it('stops walking, and sends nothing, when the walker disconnects', async () => {
      const ada = person();
      const walker = await arrive(ada);
      const grace = await inTheLibrary();

      goTo(walker, grace.userId);
      await waitFor(walker, (m) => m.type === 'walking');
      await leave(walker);
      const movesOf = () =>
        grace.conn.messages.filter(
          (m) =>
            m.type === 'moved' &&
            (m.players as { userId: string }[]).some((p) => p.userId === ada),
        ).length;
      await quiet();
      const before = movesOf();
      await new Promise((resolve) =>
        setTimeout(resolve, env.WORLD_STEP_MS * 3),
      );

      expect(movesOf()).toBe(before);
      expect(walker.messages.some((m) => m.type === 'walkEnded')).toBe(false);
      await leave(grace.conn);
    });

    it('stops walking, and sends no walkEnded, when the server shuts down', async () => {
      const own = await ownWorld([], { stepMs: 500 });
      try {
        const grace = person();
        await own.open(grace, { x: 4, y: 4 });
        const walker = await own.open(person());

        goTo(walker, grace);
        await waitFor(walker, (m) => m.type === 'walking');
        await own.gateway.stop();

        await expect(walker.closed).resolves.toBe(
          CLOSES['server shutting down'].code,
        );
        expect(
          walker.messages.filter((m) => m.type === 'walking'),
        ).toHaveLength(1);
        expect(walker.messages.some((m) => m.type === 'walkEnded')).toBe(false);
      } finally {
        await own.close();
      }
    });

    it('stops beside a door that closes mid-walk', async () => {
      const walker = await arrive(person());
      const grace = await inTheLibrary();

      goTo(walker, grace.userId);
      await waitFor(walker, (m) => m.type === 'walking');
      send(grace.conn, { type: 'setLock', locked: true });

      const ended = await walkEnded(walker);
      expect(ended).toMatchObject({
        reason: 'refused',
        spaceKey: 'library',
        mayAsk: true,
        player: { x: 2 },
      });
      expect(
        walker.messages.filter(
          (m) => m.type === 'walking' && (m.player as { x: number }).x >= 3,
        ),
      ).toEqual([]);
      await Promise.all([leave(walker), leave(grace.conn)]);
    });

    it('gives up with no_way once the walk reaches its step limit', async () => {
      const own = await ownWorld([], { walkMaxSteps: 2 });
      try {
        const grace = person();
        await own.open(grace, { x: 4, y: 4 });
        const walker = await own.open(person());

        goTo(walker, grace);

        const ended = await walkEnded(walker);
        expect(ended).toMatchObject({ reason: 'no_way' });
        expect(apart(ended.player, { x: 0, y: 0 })).toBe(2);
        expect(
          walker.messages.filter((m) => m.type === 'walking'),
        ).toHaveLength(2);
      } finally {
        await own.close();
      }
    });

    it('says they are elsewhere when another world server holds them', async () => {
      const walker = await arrive(person());
      const grace = person();
      presence.onOtherInstances.push({
        userId: grace,
        cohortId: COHORT,
        connectionId: 'held-elsewhere',
        spaceKey: DEFAULT_SPACE_KEY,
        since: Date.now(),
        status: 'available',
        instanceId: 'another-instance',
      });
      try {
        goTo(walker, grace);

        await expect(walkEnded(walker)).resolves.toMatchObject({
          userId: grace,
          reason: 'elsewhere',
        });
      } finally {
        presence.onOtherInstances.length = 0;
        await leave(walker);
      }
    });

    it('stops when they step themselves, then takes the step', async () => {
      const walker = await arrive(person());
      const grace = await inTheLibrary();

      goTo(walker, grace.userId);
      move(walker, 'down', 1);

      await expect(walkEnded(walker)).resolves.toMatchObject({
        reason: 'stopped',
      });
      await expect(
        waitFor(walker, (m) => m.type === 'moveResult' && m.seq === 1),
      ).resolves.toBeDefined();
      await Promise.all([leave(walker), leave(grace.conn)]);
    });

    it('stops when they say stop', async () => {
      const walker = await arrive(person());
      const grace = await inTheLibrary();

      goTo(walker, grace.userId);
      send(walker, { type: 'stopWalking' });

      await expect(walkEnded(walker)).resolves.toMatchObject({
        reason: 'stopped',
      });
      await Promise.all([leave(walker), leave(grace.conn)]);
    });

    it('says they are gone when they leave mid-walk, or were never here', async () => {
      const walker = await arrive(person());
      const grace = await inTheLibrary();

      goTo(walker, grace.userId);
      await waitFor(walker, (m) => m.type === 'walking');
      await leave(grace.conn);

      await expect(walkEnded(walker)).resolves.toMatchObject({
        userId: grace.userId,
        reason: 'gone',
      });

      walker.messages.length = 0;
      goTo(walker, 'nobody-here');
      await expect(walkEnded(walker)).resolves.toMatchObject({
        userId: 'nobody-here',
        reason: 'gone',
      });
      await leave(walker);
    });

    it('will not walk somebody to themselves', async () => {
      const ada = person();
      const walker = await arrive(ada);

      goTo(walker, ada);

      await expect(
        waitFor(walker, (m) => m.type === 'error'),
      ).resolves.toMatchObject({ code: 'NOT_ALLOWED' });
      await leave(walker);
    });

    describe('to a space or a tile', () => {
      it('walks them to the middle of a space, naming the space on every step', async () => {
        const walker = await arrive(person());

        send(walker, { type: 'goToSpace', spaceKey: 'library' });

        const ended = await walkEnded(walker);
        expect(ended).toMatchObject({
          userId: null,
          toSpaceKey: 'library',
          toTile: null,
          reason: 'arrived',
          player: { x: 3, y: 0 },
          spaceKey: null,
        });
        const steps = walker.messages.filter((m) => m.type === 'walking');
        expect(steps).toHaveLength(3);
        for (const walking of steps) {
          expect(walking).toMatchObject({
            userId: null,
            toSpaceKey: 'library',
            toTile: null,
          });
        }
        await leave(walker);
      });

      it('takes the next free tile when the middle is taken', async () => {
        const grace = await inTheLibrary();
        const walker = await arrive(person());

        send(walker, { type: 'goToSpace', spaceKey: 'library' });

        await expect(walkEnded(walker)).resolves.toMatchObject({
          reason: 'arrived',
          player: { x: 4, y: 0 },
        });
        await Promise.all([leave(walker), leave(grace.conn)]);
      });

      it('stops beside a space closed to them', async () => {
        designateLibrary();
        await world.gateway.spacesChanged();
        const walker = await arrive(person());

        send(walker, { type: 'goToSpace', spaceKey: 'library' });

        await expect(walkEnded(walker)).resolves.toMatchObject({
          toSpaceKey: 'library',
          reason: 'refused',
          spaceKey: 'library',
          player: { x: 2, y: 0 },
        });
        await leave(walker);
      });

      it('walks them onto a tile in the corridors', async () => {
        const walker = await arrive(person());

        send(walker, { type: 'goToTile', x: 2, y: 4 });

        await expect(walkEnded(walker)).resolves.toMatchObject({
          userId: null,
          toSpaceKey: null,
          toTile: { x: 2, y: 4 },
          reason: 'arrived',
          player: { x: 2, y: 4 },
        });
        await leave(walker);
      });

      it('arrives at once, without a step, when already there', async () => {
        const grace = await inTheLibrary();
        const walker = await arrive(person());

        send(grace.conn, { type: 'goToSpace', spaceKey: 'library' });
        send(walker, { type: 'goToTile', x: 0, y: 0 });

        await expect(walkEnded(grace.conn)).resolves.toMatchObject({
          toSpaceKey: 'library',
          reason: 'arrived',
          player: { x: 3, y: 0 },
        });
        await expect(walkEnded(walker)).resolves.toMatchObject({
          toTile: { x: 0, y: 0 },
          reason: 'arrived',
          player: { x: 0, y: 0 },
        });
        for (const conn of [grace.conn, walker]) {
          expect(conn.messages.some((m) => m.type === 'walking')).toBe(false);
        }
        await Promise.all([leave(walker), leave(grace.conn)]);
      });

      it('stops beside a closed space a tile is in', async () => {
        designateLibrary();
        await world.gateway.spacesChanged();
        const walker = await arrive(person());

        send(walker, { type: 'goToTile', x: 4, y: 1 });

        await expect(walkEnded(walker)).resolves.toMatchObject({
          toTile: { x: 4, y: 1 },
          reason: 'refused',
          spaceKey: 'library',
        });
        await leave(walker);
      });

      it('replaces a walk to somebody, and stops when asked', async () => {
        const grace = await inTheLibrary();
        const walker = await arrive(person());

        goTo(walker, grace.userId);
        send(walker, { type: 'goToTile', x: 1, y: 4 });
        await expect(walkEnded(walker)).resolves.toMatchObject({
          userId: grace.userId,
          reason: 'stopped',
        });

        walker.messages.length = 0;
        send(walker, { type: 'stopWalking' });
        await expect(walkEnded(walker)).resolves.toMatchObject({
          toTile: { x: 1, y: 4 },
          reason: 'stopped',
        });
        await Promise.all([leave(walker), leave(grace.conn)]);
      });

      it.each([
        ['the corridors', { type: 'goToSpace', spaceKey: '_default' }],
        ['a space not on the map', { type: 'goToSpace', spaceKey: 'attic' }],
        ['a wall', { type: 'goToTile', x: 0, y: 2 }],
        ['a tile off the map', { type: 'goToTile', x: 9, y: 9 }],
      ])('will not walk them to %s', async (_, message) => {
        const walker = await arrive(person());

        send(walker, message);

        await expect(
          waitFor(walker, (m) => m.type === 'error'),
        ).resolves.toMatchObject({ code: 'NOT_ALLOWED' });
        expect(walker.messages.some((m) => m.type === 'walking')).toBe(false);
        await leave(walker);
      });
    });
  });
});
