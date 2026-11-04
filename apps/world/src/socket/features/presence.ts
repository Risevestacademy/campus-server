import type {
  Displacement,
  Presence,
  PresenceStore,
} from '../../infra/presence.js';
import type { Connection } from '../connections.js';
import type { WorldContext } from '../context.js';
import { oneAtATime } from '../one-at-a-time.js';

type PresenceContext = Pick<
  WorldContext,
  'app' | 'env' | 'connections' | 'send' | 'broadcast' | 'closeFor'
>;

function presenceOf(connection: Connection): Presence {
  return {
    userId: connection.userId,
    connectionId: connection.id,
    cohortId: connection.cohortId,
    spaceKey: connection.spaceKey,
    since: connection.openedAt,
    status: connection.availability.shown,
  };
}

export type PresenceSync = ReturnType<typeof createPresence>;

export function createPresence(
  ctx: PresenceContext,
  store: PresenceStore,
  drop: (connection: Connection) => void,
) {
  const { app, env, connections, send, broadcast, closeFor } = ctx;
  const awayAfterMs = env.WORLD_AWAY_AFTER_SECONDS * 1000;

  /** A write found a newer connection holding this one's place. */
  function lostPlace(connection: Connection): void {
    displacedElsewhere({
      userId: connection.userId,
      connectionId: connection.id,
    });
  }

  /**
   * A newer connection to this cohort on another instance may have reached
   * Redis first; it holds the place, and this one closes as if displaced.
   */
  function enter(connection: Connection): void {
    store.enter(presenceOf(connection)).then(
      (held) => {
        if (!held) lostPlace(connection);
      },
      (err: unknown) => {
        app.log.warn(
          { err, userId: connection.userId },
          'could not record presence, the next renewal will',
        );
      },
    );
  }

  /** Records the new space now, not at the next renewal. A failed write is put right by that renewal. */
  function changeSpace(connection: Connection): void {
    store.changeSpace(presenceOf(connection)).then(
      (held) => {
        if (!held) lostPlace(connection);
      },
      (err: unknown) => {
        app.log.warn(
          { err, userId: connection.userId },
          'could not record a change of space, the next renewal will',
        );
      },
    );
  }

  /**
   * For any change to what a connection's cohort sees of its status: sent at
   * once, like an arrival, since it is as rare, and to them as well, which is
   * how they learn the server took them for away. Into presence without
   * holding anybody up; a write that fails is put right by the next renewal,
   * which carries the status too.
   */
  function statusChanged(connection: Connection): void {
    broadcast(connection.cohortId, {
      type: 'statusChanged',
      userId: connection.userId,
      status: connection.availability.shown,
    });
    store.setStatus(presenceOf(connection)).catch((err: unknown) => {
      app.log.warn(
        { err, userId: connection.userId },
        'could not record status, the next renewal will',
      );
    });
  }

  function noteActivity(connection: Connection): void {
    if (connection.availability.active(Date.now())) {
      statusChanged(connection);
    }
  }

  function checkIdle(connection: Connection, now: number): void {
    if (connection.availability.checkIdle(now, awayAfterMs)) {
      statusChanged(connection);
    }
  }

  /**
   * Entries this instance stops renewing lapse on their own, so a failure
   * here only leaves somebody looking online a little longer.
   */
  function leave(leaving: readonly Connection[]): void {
    if (leaving.length === 0) return;
    store.leave(leaving.map(presenceOf)).catch((err: unknown) => {
      app.log.warn({ err }, 'could not remove presence');
    });
  }

  /**
   * The account entered the same cohort on another instance. Closed as a
   * second tab here would close it, except the avatar leaves this instance
   * too: it now stands on that one.
   */
  function displacedElsewhere({ userId, connectionId }: Displacement): void {
    const connection = connections
      .forUser(userId)
      .find((open) => open.id === connectionId);
    if (!connection) {
      return;
    }
    app.log.info(
      { connectionId, userId, cohortId: connection.cohortId },
      'socket displaced, account entered this cohort on another instance',
    );
    drop(connection);
    send(connection.socket, { type: 'replaced' });
    closeFor(connection.socket, 'entered_elsewhere');
  }
  store.onDisplaced(displacedElsewhere);

  /**
   * Also how somebody comes back into presence after Redis was away, and how
   * a displacement whose message never arrived is caught.
   */
  async function renew(): Promise<void> {
    const open = connections.all();
    if (open.length === 0) return;
    for (const displaced of await store.renew(open.map(presenceOf))) {
      displacedElsewhere(displaced);
    }
  }

  const renewal = setInterval(
    oneAtATime(renew, (err) => {
      app.log.warn({ err }, 'could not renew presence');
    }),
    (env.WORLD_PRESENCE_TTL_SECONDS * 1000) / 3,
  );
  renewal.unref();

  function stopRenewing(): void {
    clearInterval(renewal);
  }

  async function leaveAll(): Promise<void> {
    try {
      await store.leave(connections.all().map(presenceOf));
    } catch (err) {
      app.log.warn({ err }, 'could not remove presence on shutdown');
    }
  }

  return {
    enter,
    changeSpace,
    statusChanged,
    noteActivity,
    checkIdle,
    leave,
    stopRenewing,
    leaveAll,
  };
}
