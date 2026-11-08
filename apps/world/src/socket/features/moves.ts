import type { Player } from '../../movement/players.js';
import { SeatMap, type Seat } from '../../seat.js';
import type { Connection } from '../connections.js';
import type { WorldContext } from '../context.js';
import { encode } from '../protocol.js';
import type { Calls } from './calls.js';

type MovesContext = Pick<
  WorldContext,
  'env' | 'connections' | 'players' | 'sendFrame'
>;

export function createMoves(
  ctx: MovesContext,
  calls: Pick<Calls, 'takeStaleNearby' | 'updateNearby'>,
  hasMedia: boolean,
) {
  const { env, connections, players, sendFrame } = ctx;

  /**
   * Who moved since the last tick, by account and cohort. Holds names, not
   * positions: the tick reads where each person stands when it runs, so
   * several steps in one tick collapse into the last.
   */
  const pendingMoves = new SeatMap<Seat>();

  /**
   * Sends once per tick rather than once per step. Per step, every move is a
   * frame to every socket, so a room of n people walking costs n² frames a
   * step; per tick it is one frame per socket, however many moved.
   */
  function flushMoves(): void {
    const touched = calls.takeStaleNearby();
    for (const { cohortId } of pendingMoves.values()) touched.add(cohortId);
    sendMoves();
    if (!hasMedia || touched.size === 0) return;
    const byCohort = new Map<string, Connection[]>();
    for (const connection of connections.all()) {
      if (!touched.has(connection.cohortId)) continue;
      const inCohort = byCohort.get(connection.cohortId);
      if (inCohort) inCohort.push(connection);
      else byCohort.set(connection.cohortId, [connection]);
    }
    for (const inCohort of byCohort.values()) calls.updateNearby(inCohort);
  }

  function sendMoves(): void {
    if (pendingMoves.size === 0) {
      return;
    }
    // Grouped by cohort: each is its own campus, and a move is news only to
    // the people standing in the same one.
    const movedIn = new Map<string, Player[]>();
    for (const { userId, cohortId } of pendingMoves.values()) {
      const player = players.get({ userId, cohortId });
      // Left since the step: `left` has already gone out, and an entry now
      // would put back an avatar the client has just taken away.
      if (!player || !connections.holderOf({ userId, cohortId })) continue;
      const moved = movedIn.get(cohortId);
      if (moved) moved.push(player);
      else movedIn.set(cohortId, [player]);
    }
    pendingMoves.clear();

    for (const [cohortId, moved] of movedIn) {
      const movedIds = new Set(moved.map((player) => player.userId));
      // Encoded once for everybody who did not move; somebody who did needs
      // their own, without the entry their `moveResult` already answered.
      const shared = encode({ type: 'moved', players: moved });
      for (const connection of connections.all()) {
        if (connection.cohortId !== cohortId) continue;
        if (!movedIds.has(connection.userId)) {
          sendFrame(connection.socket, shared);
          continue;
        }
        const others = moved.filter(
          (player) => player.userId !== connection.userId,
        );
        if (others.length > 0) {
          sendFrame(
            connection.socket,
            encode({ type: 'moved', players: others }),
          );
        }
      }
    }
  }

  const tick = setInterval(flushMoves, env.WORLD_TICK_MS);
  tick.unref();

  return {
    moved(seat: Seat): void {
      pendingMoves.set(seat, seat);
    },
    /** Any step of theirs the tick has not sent yet goes with them. */
    forget(seat: Seat): void {
      pendingMoves.delete(seat);
    },
    stop(): void {
      clearInterval(tick);
    },
  };
}
