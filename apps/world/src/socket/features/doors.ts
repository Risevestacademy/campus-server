import { DEFAULT_SPACE_KEY } from '@campus/session';
import {
  SPACE_ACCESS,
  roomLinkOpen,
  type SpaceFacts,
} from '@campus/space-access';

import type {
  AccountLookup,
  RoomLinkPass,
  WorldSpace,
} from '../../infra/accounts.js';
import { traced } from '../../infra/traced.js';
import type { Connection } from '../connections.js';
import type { WorldContext } from '../context.js';
import { encode, type SpaceName } from '../protocol.js';

type DoorsContext = Pick<
  WorldContext,
  'app' | 'map' | 'connections' | 'sendFrame' | 'isStopping'
>;

/**
 * What a drawn space the database has no row for is taken as: a normal
 * space, open to anybody in the campus. The map was published and the sync
 * has not run since, and a room nobody has set up is not a reason to keep
 * people out of it. The boot log names the space. A row with no kind is a
 * different thing: an admin's space not yet set up, which admits admins only.
 */
const NOT_YET_SYNCED: SpaceFacts = {
  kind: 'open',
  access: SPACE_ACCESS.Normal,
  retiredAt: null,
  locked: false,
  grants: [],
};

/**
 * What every drawn space is taken as before the spaces have been read even
 * once, as when the database is out of reach at boot: admins only. Not
 * knowing whether a room is designated is not the same as knowing it has no
 * row, and the safe guess about a list nobody has read is that you are not
 * on it. The corridors stay open; the next read that succeeds opens the rest.
 */
const NOT_YET_READ: SpaceFacts = {
  kind: null,
  access: SPACE_ACCESS.Designated,
  retiredAt: null,
  locked: false,
  grants: [],
};

export type Doors = ReturnType<typeof createDoors>;

export function createDoors(
  ctx: DoorsContext,
  accounts: AccountLookup,
  afterRead: () => void,
) {
  const { app, map, connections, sendFrame, isStopping } = ctx;

  /**
   * Every space on this map as the database last said, by key: what each
   * door decides from. Read whole, at boot, whenever campus-api says a space
   * or a list changed, and every heartbeat in case that word went missing.
   * A read that fails keeps what the doors had.
   */
  let doors: ReadonlyMap<string, WorldSpace> = new Map();
  /** Whether a read has ever succeeded, so a missing key means no row. */
  let doorsRead = false;
  /** Who entered through a room link, read with the doors. */
  let roomLinkPasses: readonly RoomLinkPass[] = [];
  let doorsLoading: Promise<void> | undefined;
  let readDoorsAgain = false;
  let spaceNames = spaceNamesFrom(doors);

  /**
   * One read at a time. Asked again while one is running, the running one
   * reads once more when it is done, so a change that lands mid-read is
   * never left behind; everybody asking waits for the same read.
   */
  function reload(): Promise<void> {
    if (doorsLoading) {
      readDoorsAgain = true;
      return doorsLoading;
    }
    doorsLoading = (async () => {
      do {
        readDoorsAgain = false;
        try {
          doors = await traced('world.spaces.read', () =>
            accounts.spacesOn(map.id, new Date()),
          );
          doorsRead = true;
          await readRoomLinkPasses();
          afterRead();
        } catch (err) {
          app.log.error(
            { err },
            'could not read the spaces; doors keep what they had',
          );
        }
      } while (readDoorsAgain);
    })().finally(() => {
      doorsLoading = undefined;
    });
    return doorsLoading;
  }

  /** Apart from the doors, so a failed read leaves the doors current. */
  async function readRoomLinkPasses(): Promise<void> {
    try {
      roomLinkPasses = await traced('world.room_link_passes.read', () =>
        accounts.roomLinkPassesOn(map.id, new Date()),
      );
    } catch (err) {
      app.log.error(
        { err },
        'could not read room link passes; they keep what they had',
      );
    }
  }

  function holdsRoomLinkPass(
    connection: Connection,
    spaceKey: string,
    now: Date,
  ): boolean {
    return roomLinkPasses.some(
      (pass) =>
        pass.spaceKey === spaceKey &&
        pass.userId === connection.userId &&
        pass.cohortId === connection.cohortId &&
        roomLinkOpen(pass, now),
    );
  }

  const ready = reload().then(() => {
    if (!doorsRead) {
      return; // Already logged, and the heartbeat reads again.
    }
    const unknown = map.spaces.keys.filter((key) => !doors.has(key));
    if (unknown.length > 0) {
      app.log.warn(
        { spaces: unknown },
        'drawn spaces with no row in the database: open to everybody until the maps are synced',
      );
    }
  });

  function spaceNamesFrom(read: ReadonlyMap<string, WorldSpace>): SpaceName[] {
    return [DEFAULT_SPACE_KEY, ...map.spaces.keys].map((spaceKey) => ({
      spaceKey,
      name: read.get(spaceKey)?.name ?? spaceKey,
    }));
  }

  function refreshNames(): void {
    if (isStopping()) return;
    const next = spaceNamesFrom(doors);
    if (next.every(({ name }, i) => name === spaceNames[i]?.name)) return;
    spaceNames = next;
    const frame = encode({ type: 'spaces', spaces: next });
    for (const connection of connections.all()) {
      sendFrame(connection.socket, frame);
    }
  }

  return {
    reload,
    ready,
    readRoomLinkPasses,
    holdsRoomLinkPass,
    refreshNames,
    get: (spaceKey: string): WorldSpace | undefined => doors.get(spaceKey),
    all: (): ReadonlyMap<string, WorldSpace> => doors,
    hasBeenRead: (): boolean => doorsRead,
    /** What a door decides from, for a space with or without a row. */
    factsFor: (spaceKey: string): SpaceFacts =>
      doors.get(spaceKey) ?? (doorsRead ? NOT_YET_SYNCED : NOT_YET_READ),
    names: (): readonly SpaceName[] => spaceNames,
  };
}
