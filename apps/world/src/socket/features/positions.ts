import type { PositionStore, PositionToSave } from '../../infra/positions.js';
import type { Player } from '../../movement/players.js';
import { seatKey, type Seat } from '../../seat.js';
import type { WorldContext } from '../context.js';

type PositionsContext = Pick<
  WorldContext,
  'app' | 'env' | 'connections' | 'players'
>;

/** A store write for one player, in the cohort named. */
export function positionOf(player: Player, cohortId: string): PositionToSave {
  return {
    userId: player.userId,
    cohortId,
    x: player.x,
    y: player.y,
    facing: player.facing,
  };
}

export type PositionWrites = ReturnType<typeof createPositions>;

export function createPositions(ctx: PositionsContext, store: PositionStore) {
  const { app, env, connections, players } = ctx;

  /**
   * Who has moved since their position was last written to the store, by
   * account and cohort. Not a position: the save reads where they stand when
   * it runs.
   */
  const unsaved = new Map<string, Seat>();

  /**
   * Writes positions without holding anybody up. A failure only means the
   * position is not kept — see PositionStore — so it is logged, and anybody
   * still here is put back for the next periodic save to retry. Somebody who
   * has left cannot be retried that way: if the save as they left fails,
   * what was last written for them, at most one interval old, stands.
   */
  function persist(entries: readonly PositionToSave[]): void {
    if (entries.length === 0) return;
    store.save(entries).catch((err: unknown) => {
      app.log.warn({ err, count: entries.length }, 'could not save positions');
      for (const { userId, cohortId } of entries) {
        // Retried only while the account is still in that cohort.
        if (connections.holderOf({ userId, cohortId })) {
          unsaved.set(seatKey({ userId, cohortId }), { userId, cohortId });
        }
      }
    });
  }

  function moved(seat: Seat): void {
    unsaved.set(seatKey(seat), seat);
  }

  /** Written as they leave, so the periodic save has nothing left to do for them. */
  function left(player: Player, cohortId: string): void {
    unsaved.delete(seatKey({ userId: player.userId, cohortId }));
    persist([positionOf(player, cohortId)]);
  }

  /** Forgets one cohort's kept position, for access taken away. */
  function forget(seat: Seat): void {
    const { userId, cohortId } = seat;
    unsaved.delete(seatKey(seat));
    store.forget(seat).catch((err: unknown) => {
      app.log.warn(
        { err, userId, cohortId },
        'could not forget saved position',
      );
    });
  }

  /**
   * Everybody still here who moved since the last write, as a store write in
   * the cohort they moved in. Somebody who left in the meantime was written
   * as they left (drop), so is skipped here.
   */
  function saveMoved(): void {
    const entries: PositionToSave[] = [];
    for (const { userId, cohortId } of unsaved.values()) {
      const player = players.get({ userId, cohortId });
      if (player) entries.push(positionOf(player, cohortId));
    }
    unsaved.clear();
    persist(entries);
  }

  const periodicSave = setInterval(
    saveMoved,
    env.WORLD_POSITION_SAVE_SECONDS * 1000,
  );
  periodicSave.unref();

  /**
   * Everybody still here, whether or not they moved since the last save:
   * a redeploy should put nobody back at the spawn. Before the sockets
   * close, so the positions written are the ones they stood at.
   */
  async function stop(): Promise<void> {
    clearInterval(periodicSave);
    unsaved.clear();
    try {
      await store.save(
        connections.all().flatMap((connection) => {
          const player = players.get(connection);
          return player ? [positionOf(player, connection.cohortId)] : [];
        }),
      );
    } catch (err) {
      app.log.warn({ err }, 'could not save positions on shutdown');
    }
  }

  return { moved, left, forget, stop };
}
