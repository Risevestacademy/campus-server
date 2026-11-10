import { DEFAULT_SPACE_KEY } from '@campus/session';

import type { PresenceStore } from '../../infra/presence.js';
import {
  Direction,
  step,
  tileIndex,
  walkable,
  type Tile,
} from '../../movement/grid.js';
import { pathTo } from '../../movement/paths.js';
import type { Player } from '../../movement/players.js';
import { floorByMiddle, spaceAt } from '../../movement/spaces.js';
import { besideSpace } from '../../spaces/requests.js';
import type { Connection } from '../connections.js';
import type { WorldContext } from '../context.js';
import { ServerErrorCode, type WalkEndReason } from '../protocol.js';
import type { EntryRequestsFeature } from './entry-requests.js';

type WalksContext = Pick<
  WorldContext,
  'app' | 'env' | 'map' | 'connections' | 'players' | 'send' | 'isStopping'
>;

type WalkTarget =
  | { kind: 'person'; userId: string }
  | { kind: 'space'; spaceKey: string }
  | { kind: 'tile'; tile: Tile };

interface WalkPlan {
  path: Direction[];
  closed: string | null;
}

/** A walk's target as `walking` and `walkEnded` name it. */
function targetFields(target: WalkTarget) {
  return {
    userId: target.kind === 'person' ? target.userId : null,
    toSpaceKey: target.kind === 'space' ? target.spaceKey : null,
    toTile:
      target.kind === 'tile' ? { x: target.tile.x, y: target.tile.y } : null,
  };
}

interface Walk {
  target: WalkTarget;
  timer: NodeJS.Timeout;
  path: Direction[];
  /** Where the person walked to stood when `path` was found. */
  aimedAt: Tile | null;
  taken: number;
  /** Steps refused or blocked in a row. */
  failed: number;
  /** Whether the passes were read again before a refusal, as they are once. */
  rechecked: boolean;
}

export interface WalkDeps {
  presence: Pick<PresenceStore, 'online' | 'instanceId'>;
  readRoomLinkPasses(): Promise<void>;
  requests: Pick<EntryRequestsFeature, 'hasPass' | 'passFor' | 'mayAsk'>;
  mayStepInto(connection: Connection, spaceKey: string, now: Date): boolean;
  /** Whether a space is at capacity, not counting this person. */
  isFull(connection: Connection, spaceKey: string): boolean;
  noteMoved(connection: Connection): void;
  arrivedAt(connection: Connection, tile: Tile): void;
}

export type Walks = ReturnType<typeof createWalks>;

export function createWalks(
  ctx: WalksContext,
  {
    presence,
    readRoomLinkPasses,
    requests,
    mayStepInto,
    isFull,
    noteMoved,
    arrivedAt,
  }: WalkDeps,
) {
  const { app, env, map, connections, players, send, isStopping } = ctx;
  const walks = new Map<Connection, Walk>();
  const walkLimit =
    env.WORLD_WALK_MAX_STEPS ?? map.grid.width * map.grid.height;

  /**
   * Why a space is closed to this person, or null when they may step in.
   * `refused` comes first: a space they may not enter at all is not "full"
   * to them. Asked only on a step into another space: somebody already
   * inside stays until they leave, whatever has changed since they came in,
   * a lowered capacity included.
   */
  function whyClosed(
    connection: Connection,
    spaceKey: string,
    now: number,
  ): 'refused' | 'full' | null {
    if (spaceKey === connection.spaceKey) return null;
    if (
      !mayStepInto(connection, spaceKey, new Date(now)) &&
      !requests.hasPass(connection, spaceKey)
    ) {
      return 'refused';
    }
    if (isFull(connection, spaceKey)) return 'full';
    return null;
  }

  function admitsStep(connection: Connection, now: number) {
    return (target: Tile): true | 'refused' | 'full' =>
      whyClosed(connection, spaceAt(map.spaces, target), now) ?? true;
  }

  /** whyClosed, asked once per space: a search asks of every tile. */
  function crossingFor(connection: Connection, now: number) {
    const answers = new Map<string, boolean>();
    return (tile: Tile) => {
      const into = spaceAt(map.spaces, tile);
      let answer = answers.get(into);
      if (answer === undefined) {
        answer = whyClosed(connection, into, now) === null;
        answers.set(into, answer);
      }
      return answer;
    };
  }

  function goTo(connection: Connection, userId: string): void {
    if (userId === connection.userId) {
      send(connection.socket, {
        type: 'error',
        code: ServerErrorCode.NotAllowed,
        message: 'you cannot walk to yourself',
      });
      return;
    }
    startWalk(connection, { kind: 'person', userId });
  }

  function goToSpace(connection: Connection, spaceKey: string): void {
    if (
      spaceKey === DEFAULT_SPACE_KEY ||
      !map.spaces.keys.includes(spaceKey) ||
      floorOf(spaceKey).length === 0
    ) {
      send(connection.socket, {
        type: 'error',
        code: ServerErrorCode.NotAllowed,
        message:
          spaceKey === DEFAULT_SPACE_KEY
            ? 'walk to a tile in the corridors, not to the corridors'
            : 'no space with that key to walk into',
      });
      return;
    }
    startWalk(connection, { kind: 'space', spaceKey });
  }

  function goToTile(connection: Connection, tile: Tile): void {
    if (!walkable(map.grid, tile)) {
      send(connection.socket, {
        type: 'error',
        code: ServerErrorCode.NotAllowed,
        message: 'that tile is off the map or in a wall',
      });
      return;
    }
    startWalk(connection, { kind: 'tile', tile });
  }

  function startWalk(connection: Connection, target: WalkTarget): void {
    endWalk(connection, 'stopped');
    walks.set(connection, {
      target,
      path: [],
      aimedAt: null,
      taken: 0,
      failed: 0,
      rechecked: false,
      timer: setTimeout(() => walkOn(connection), 0).unref(),
    });
  }

  const floors = new Map<string, Tile[]>();

  function floorOf(spaceKey: string): Tile[] {
    let floor = floors.get(spaceKey);
    if (!floor) {
      floor = floorByMiddle(map.grid, map.spaces, spaceKey);
      floors.set(spaceKey, floor);
    }
    return floor;
  }

  /** The free tile nearest the space's middle, or its middle when none is. */
  function middleOf(connection: Connection, spaceKey: string): Tile {
    const floor = floorOf(spaceKey);
    const taken = new Set(
      players
        .in(connection.cohortId)
        .filter((player) => player.userId !== connection.userId)
        .map((player) => tileIndex(map.grid, player)),
    );
    return (
      floor.find((tile) => !taken.has(tileIndex(map.grid, tile))) ??
      (floor[0] as Tile)
    );
  }

  function cancelWalk(connection: Connection): Walk | undefined {
    const walk = walks.get(connection);
    if (walk) {
      clearTimeout(walk.timer);
      walks.delete(connection);
    }
    return walk;
  }

  function endWalk(
    connection: Connection,
    reason: WalkEndReason,
    spaceKey: string | null = null,
  ): void {
    const walk = cancelWalk(connection);
    const player = players.get(connection);
    if (!walk || !player) return;
    send(connection.socket, {
      type: 'walkEnded',
      ...targetFields(walk.target),
      reason,
      player,
      spaceKey,
      // Asking gets past a list or a lock, never a full room.
      mayAsk:
        reason !== 'full' &&
        spaceKey !== null &&
        requests.mayAsk(connection, spaceKey, new Date()),
    });
  }

  /**
   * To a tile next to them in their space, never onto theirs; undefined when
   * their space has no such tile. When a space closed to this person is in
   * the way, to the nearest tile beside the first one.
   */
  function planWalk(
    connection: Connection,
    from: Tile,
    to: Tile,
    now: number,
  ): WalkPlan | undefined {
    const crosses = crossingFor(connection, now);
    const theirs = spaceAt(map.spaces, to);
    const arrived = (tile: Tile) =>
      Math.abs(tile.x - to.x) + Math.abs(tile.y - to.y) === 1 &&
      spaceAt(map.spaces, tile) === theirs;
    const room = Object.values(Direction).some((direction) => {
      const tile = step(to, direction);
      return walkable(map.grid, tile) && arrived(tile);
    });
    if (crosses(to) && !room) return undefined;
    return planToward(connection, from, to, arrived, crosses);
  }

  /** Onto the tile asked for, or the free one nearest a space's middle. */
  function planPlaceWalk(
    connection: Connection,
    from: Tile,
    target: Exclude<WalkTarget, { kind: 'person' }>,
    now: number,
  ): WalkPlan | undefined {
    const to =
      target.kind === 'space'
        ? middleOf(connection, target.spaceKey)
        : target.tile;
    return planToward(
      connection,
      from,
      to,
      (tile) => tile.x === to.x && tile.y === to.y,
      crossingFor(connection, now),
    );
  }

  /**
   * To a tile `arrived` accepts near `to`. When `to`'s space is closed to this
   * person, or a closed space is in the way, to the nearest tile beside the
   * first one.
   */
  function planToward(
    connection: Connection,
    from: Tile,
    to: Tile,
    arrived: (tile: Tile) => boolean,
    crosses: (tile: Tile) => boolean,
  ): WalkPlan | undefined {
    const theirs = spaceAt(map.spaces, to);
    if (crosses(to)) {
      // A yes lapses a step away from the door, so a walk holding one for
      // their space keeps to the door if it can.
      const pass = requests.passFor(connection);
      const keepsPass = (tile: Tile) =>
        crosses(tile) &&
        (spaceAt(map.spaces, tile) === pass ||
          besideSpace(map.grid, map.spaces, tile, pass as string));
      for (const mayCross of pass === theirs
        ? [keepsPass, crosses]
        : [crosses]) {
        const path = pathTo(map.grid, from, arrived, mayCross);
        if (path) return { path, closed: null };
      }
    } else {
      const path = pathTo(
        map.grid,
        from,
        (tile) => besideSpace(map.grid, map.spaces, tile, theirs),
        crosses,
      );
      if (path) return { path, closed: theirs };
    }
    const closed = firstClosedOnTheWay(from, to, crosses);
    if (closed === undefined) return undefined;
    const path = pathTo(
      map.grid,
      from,
      (tile) => besideSpace(map.grid, map.spaces, tile, closed),
      crosses,
    );
    return path && { path, closed };
  }

  /**
   * Walks live in this instance, so somebody connected to another one is out
   * of reach, not gone.
   */
  async function endWalkNotHere(
    connection: Connection,
    walk: Walk,
    targetId: string,
  ) {
    let reason: WalkEndReason = 'gone';
    try {
      const online = await presence.online(connection.cohortId);
      if (
        online.some(
          (entry) =>
            entry.userId === targetId &&
            entry.instanceId !== presence.instanceId,
        )
      ) {
        reason = 'elsewhere';
      }
    } catch (err) {
      app.log.warn({ err }, 'could not read presence to end a walk');
    }
    if (walks.get(connection) === walk) endWalk(connection, reason);
  }

  /** The first space closed to them on the way to `to`, doors aside. */
  function firstClosedOnTheWay(
    from: Tile,
    to: Tile,
    crosses: (tile: Tile) => boolean,
  ): string | undefined {
    const path = pathTo(
      map.grid,
      from,
      (tile) => tile.x === to.x && tile.y === to.y,
      () => true,
    );
    let at = from;
    for (const direction of path ?? []) {
      at = step(at, direction);
      if (!crosses(at)) return spaceAt(map.spaces, at);
    }
    return undefined;
  }

  function walkOn(connection: Connection): void {
    const walk = walks.get(connection);
    if (!walk) return;
    if (isStopping() || !connections.has(connection)) {
      cancelWalk(connection);
      return;
    }
    let them: Player | undefined;
    if (walk.target.kind === 'person') {
      const target = connections.holderOf({
        userId: walk.target.userId,
        cohortId: connection.cohortId,
      });
      if (!target) {
        void endWalkNotHere(connection, walk, walk.target.userId);
        return;
      }
      them = players.get(target);
      if (!them) {
        endWalk(connection, 'gone');
        return;
      }
    }
    const me = players.get(connection);
    if (!me) {
      cancelWalk(connection);
      return;
    }
    const now = Date.now();
    if (
      walk.path.length === 0 ||
      (them && (walk.aimedAt?.x !== them.x || walk.aimedAt.y !== them.y))
    ) {
      const plan =
        walk.target.kind === 'person'
          ? planWalk(connection, me, them as Player, now)
          : planPlaceWalk(connection, me, walk.target, now);
      if (!plan) {
        endWalk(connection, 'no_way');
        return;
      }
      if (plan.path.length === 0) {
        if (plan.closed) refuseWalk(connection, walk, plan.closed);
        else endWalk(connection, 'arrived');
        return;
      }
      walk.path = plan.path;
      walk.aimedAt = them ? { x: them.x, y: them.y } : null;
    }
    if (walk.taken >= walkLimit) {
      endWalk(connection, 'no_way');
      return;
    }

    const direction = walk.path[0] as Direction;
    const moved = players.move(
      connection,
      direction,
      now,
      admitsStep(connection, now),
    );
    if (moved.changed) noteMoved(connection);
    if (moved.outcome === 'moved') {
      walk.path.shift();
      walk.taken += 1;
      walk.failed = 0;
      send(connection.socket, {
        type: 'walking',
        ...targetFields(walk.target),
        player: moved.player,
      });
      arrivedAt(connection, moved.player);
    } else if (moved.outcome !== 'too_fast') {
      // A door locked, a list changed, or a space filled since the path was
      // found.
      walk.path = [];
      walk.failed += 1;
      if (walk.failed >= 2) {
        const into = spaceAt(map.spaces, step(me, direction));
        if (moved.outcome === 'refused' || moved.outcome === 'full') {
          refuseWalk(connection, walk, into);
        } else {
          endWalk(connection, 'no_way');
        }
        return;
      }
    }
    walk.timer = setTimeout(
      () => walkOn(connection),
      env.WORLD_STEP_MS,
    ).unref();
  }

  /**
   * Ends the walk beside `into`, saying why it is closed: the reason is
   * worked out for that space, which may not be the target's.
   *
   * A pass made by entering through a room link reaches world by a read that
   * may not have finished when the walk began, so a walk about to be refused
   * reads the passes once more first, and goes on if the door now opens. A
   * full space is not waited on: no pass makes room in it.
   */
  function refuseWalk(connection: Connection, walk: Walk, into: string): void {
    if (whyClosed(connection, into, Date.now()) === 'full') {
      endWalk(connection, 'full', into);
      return;
    }
    if (walk.rechecked) {
      endWalk(connection, 'refused', into);
      return;
    }
    walk.rechecked = true;
    void readRoomLinkPasses().then(() => {
      if (walks.get(connection) !== walk) return;
      walk.path = [];
      walk.failed = 0;
      walkOn(connection);
    });
  }

  function cancelAll(): void {
    for (const walker of walks.keys()) cancelWalk(walker);
  }

  /**
   * The map changed: a path found against the old walls may cross a new one.
   * It is dropped, not the walk, so the same target is walked to again from
   * where the person now stands.
   */
  function replanAll(): void {
    for (const walk of walks.values()) {
      walk.path = [];
      walk.failed = 0;
      walk.rechecked = false;
      walk.aimedAt = null;
    }
  }

  return {
    admitsStep,
    goTo,
    goToSpace,
    goToTile,
    end: endWalk,
    cancel: cancelWalk,
    cancelAll,
    replanAll,
  };
}
