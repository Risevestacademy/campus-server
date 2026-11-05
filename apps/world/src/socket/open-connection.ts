import { DEFAULT_SPACE_KEY } from '@campus/session';
import type { CohortMembershipFacts } from '@campus/space-access';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';

import type { AccountLookup } from '../infra/accounts.js';
import type { PositionStore, SavedPosition } from '../infra/positions.js';
import { annotate, traced } from '../infra/traced.js';
import { spaceAt } from '../movement/spaces.js';
import { seatKey, type Seat } from '../seat.js';
import { Availability, Status } from '../status/availability.js';
import {
  decideUpgrade,
  type Refusal,
  type UpgradeDecision,
} from './authenticate.js';
import type { Connection } from './connections.js';
import { sendClose, type WorldContext } from './context.js';
import { COHORT_QUERY_PARAM, SOCKET_PATH } from './endpoint.js';
import { avatarOf, type AppearanceFeature } from './features/appearance.js';
import type { BroadcastRoom } from './features/broadcast-room.js';
import type { Calls } from './features/calls.js';
import type { Doors } from './features/doors.js';
import type { EntryRequestsFeature } from './features/entry-requests.js';
import type { Locks } from './features/locks.js';
import type { PositionWrites } from './features/positions.js';
import type { PresenceSync } from './features/presence.js';
import { ServerErrorCode } from './protocol.js';

type OpenContext = Pick<
  WorldContext,
  | 'app'
  | 'env'
  | 'map'
  | 'connections'
  | 'players'
  | 'metrics'
  | 'send'
  | 'broadcast'
  | 'closeFor'
>;

/** How one upgrade ended, counted once, whichever way it ends. */
interface Attempt {
  outcome?: 'opened' | 'refused' | 'failed' | 'abandoned';
}

export interface OpenDeps {
  accounts: AccountLookup;
  positions: Pick<PositionStore, 'load'>;
  positionWrites: Pick<PositionWrites, 'forget'>;
  doors: Pick<Doors, 'ready' | 'hasBeenRead' | 'names'>;
  locks: Pick<Locks, 'isLocked' | 'lockableSpaces' | 'lockedIn'>;
  appearance: Pick<AppearanceFeature, 'avatarsIn'>;
  requests: Pick<EntryRequestsFeature, 'replaced' | 'review'>;
  presence: Pick<PresenceSync, 'enter'>;
  calls: Pick<Calls, 'join'>;
  broadcastRoom: Pick<BroadcastRoom, 'join'>;
  mayStepInto(connection: Connection, spaceKey: string, now: Date): boolean;
  drop(connection: Connection, remember?: boolean): void;
  /** Starts reading what the socket sends. */
  listen(connection: Connection): void;
}

/** The socket route: every upgrade is decided, and an accepted one joins the campus. */
export function registerSocketRoute(ctx: OpenContext, deps: OpenDeps): void {
  const {
    app,
    env,
    map,
    connections,
    players,
    metrics,
    send,
    broadcast,
    closeFor,
  } = ctx;
  const {
    accounts,
    positions,
    positionWrites,
    doors,
    locks,
    appearance,
    requests,
    presence,
    calls,
    broadcastRoom,
    mayStepInto,
    drop,
    listen,
  } = deps;

  // The handler returns its promise so @fastify/websocket can catch a
  // rejection; returning undefined would turn one bad socket into an
  // unhandled rejection that takes the whole process down.
  // Fastify's own span for an upgrade never ends: the socket takes the reply
  // over. world.socket.open is the trace instead.
  app.get(
    SOCKET_PATH,
    { websocket: true, config: { otel: false } },
    async (socket, request) => {
      const attempt: Attempt = {};
      await traced(
        'world.socket.open',
        async () => {
          try {
            await openConnection(
              socket,
              {
                origin: request.headers.origin,
                cookie: request.headers.cookie,
                authorization: request.headers.authorization,
              },
              cohortIdFrom(request.query),
              attempt,
            );
          } catch (err) {
            // Thrown before any outcome was counted: world's own failure.
            if (attempt.outcome === undefined) {
              attempt.outcome = 'failed';
              metrics.failed();
              annotate({ 'world.outcome': 'failed' });
            }
            throw err;
          }
        },
        { root: true },
      );
    },
  );

  async function openConnection(
    ws: WebSocket,
    headers: { origin?: string; cookie?: string; authorization?: string },
    cohortId: string | undefined,
    attempt: Attempt,
  ): Promise<void> {
    // Authentication is asynchronous, and a client can be gone before it
    // finishes. Watching for that now means a socket that dies in the
    // meantime is never registered, rather than registered and never removed.
    // Nothing is read off the socket until there is something to read it
    // with. ws parses frames as they arrive and emits them whether or not a
    // listener exists, so a client that sends the moment it is open would
    // otherwise lose those frames while authentication is still in flight.
    ws.pause();

    let registered: Connection | undefined;
    let closed = false;
    const onClose = (code: number): void => {
      metrics.closed(code);
      closed = true;
      if (registered) {
        drop(registered);
        app.log.info(
          { connectionId: registered.id, userId: registered.userId },
          'socket closed',
        );
      }
    };
    ws.on('close', onClose);
    ws.on('error', (err: Error) => {
      app.log.warn({ err }, 'socket errored');
    });

    let decision;
    try {
      decision = await decideUpgrade(env, accounts, headers, cohortId);
    } catch (err) {
      app.log.error({ err }, 'could not decide socket upgrade');
      attempt.outcome = 'failed';
      metrics.failed();
      annotate({ 'world.outcome': 'failed' });
      // Reading has to resume for the closing handshake to complete.
      ws.resume();
      sendClose(ws, 'internal_error');
      return;
    }
    // Known before the outcome, so a refusal leads to the person too.
    annotate({
      'world.cohort_id': cohortId,
      'user.id': decision.ok ? decision.claims.userId : decision.userId,
    });

    // Access taken away — the account suspended, or gone — forgets the
    // cohort this attempt named, and closes every socket the account holds,
    // in every cohort, the way the sweep closes them: through drop(), which
    // forgets each of those cohorts' kept positions too. Taking the player
    // away underneath an open socket would leave it registered with nobody
    // standing for it, so nobody would be told they left and its next move
    // would throw.
    if (!decision.ok && decision.userId) {
      const { userId } = decision;
      if (cohortId !== undefined) {
        positionWrites.forget({ userId, cohortId });
      }
      const open = connections.forUser(userId);
      for (const connection of open) {
        app.log.info(
          {
            connectionId: connection.id,
            userId,
            cohortId: connection.cohortId,
            reason: decision.refusal,
          },
          'closing socket, account no longer welcome',
        );
        drop(connection, false);
        closeFor(connection.socket, decision.refusal);
      }
      if (
        cohortId !== undefined &&
        !open.some((c) => c.cohortId === cohortId)
      ) {
        players.leave({ userId, cohortId }, Date.now(), false);
      }
    }

    // Decided, so counted as refused even if the client has already gone.
    if (!decision.ok) {
      attempt.outcome = 'refused';
      refuse(ws, decision.refusal);
      return;
    }

    // Where they stood on an earlier visit to this cohort, read before the
    // socket is checked again: the read is asynchronous too, and the socket
    // may go in the meantime. Skipped when this process will resume a
    // position in this same cohort — another tab, or a reconnect within the
    // grace. What the account holds in other cohorts has no bearing on it.
    let saved: SavedPosition | undefined;
    if (
      decision.ok &&
      !players.has(seatOf(decision)) &&
      !players.isRemembered(seatOf(decision))
    ) {
      try {
        saved = await positions.load(seatOf(decision));
      } catch (err) {
        app.log.warn(
          { err, userId: decision.claims.userId },
          'could not load saved position, starting at the spawn',
        );
      }
    }

    // Their membership row, for the doors, and the doors themselves on the
    // first arrival after boot. An admin's row is never read: the door
    // admits them on their role. A row that cannot be read leaves them in
    // the corridors until the heartbeat reads it.
    let membership: CohortMembershipFacts | null = null;
    // Whether the doors know who this is. An admin needs no row; anybody
    // else's has to have been read for a refusal to mean anything.
    let membershipKnown = decision.ok && decision.account.admin;
    if (decision.ok && !decision.account.admin) {
      const seat = seatOf(decision);
      try {
        membership =
          (await accounts.memberships([seat])).get(seatKey(seat)) ?? null;
        membershipKnown = true;
      } catch (err) {
        app.log.warn(
          { err, userId: seat.userId },
          'could not read membership for the doors, reading it again at the heartbeat',
        );
      }
    }
    await doors.ready;

    if (closed || ws.readyState !== ws.OPEN) {
      attempt.outcome = 'abandoned';
      metrics.abandoned();
      annotate({ 'world.outcome': 'abandoned' });
      return;
    }

    // A tab replacing another in this cohort keeps the status chosen there,
    // as the avatar keeps its place: nobody saw it leave. Anything else is a
    // fresh arrival, and starts Available. A status is per cohort, as the
    // avatar is: what they show in one campus says nothing in another.
    const replacing = connections.holderOf(seatOf(decision));
    const connection: Connection = {
      id: randomUUID(),
      userId: decision.claims.userId,
      email: decision.claims.email,
      cohortId: decision.cohortId,
      appearance: {
        displayName: decision.account.displayName,
        spriteKey: decision.account.spriteKey,
      },
      // Where the avatar stands is known once it has joined, below.
      spaceKey: DEFAULT_SPACE_KEY,
      systemRole: decision.account.systemRole,
      membership,
      nearby: new Set(),
      availability: new Availability(
        replacing?.availability.chosen ?? Status.Available,
        Date.now(),
      ),
      expiresAt: decision.claims.expiresAt,
      sessionId: decision.claims.sessionId,
      epoch: decision.claims.epoch,
      socket: ws,
      openedAt: Date.now(),
      alive: true,
    };
    registered = connection;

    // Joined before anybody is told, and before any frame is read, so a move
    // can never arrive for a player who is not standing anywhere yet. Another
    // socket for the same account and cohort — loaded while this one waited
    // — has already placed the avatar, and this one takes it over.
    // A saved place inside a space they may no longer enter is not where
    // they come back to: they start at the spawn, as on a first visit. Only
    // when their row and the spaces were both read: a read that failed says
    // nothing about where they may stand, and the place would be lost for
    // good once the spawn was saved over it.
    const savedIn = saved && spaceAt(map.spaces, saved);
    if (
      saved &&
      savedIn &&
      membershipKnown &&
      doors.hasBeenRead() &&
      !mayStepInto(connection, savedIn, new Date())
    ) {
      app.log.info(
        {
          userId: connection.userId,
          cohortId: connection.cohortId,
          spaceKey: savedIn,
          locked: locks.isLocked(connection.cohortId, savedIn),
        },
        'saved position is in a space closed to them now, starting at the spawn',
      );
      saved = undefined;
    }
    const arriving = !players.has(connection);
    const player = players.join(connection, Date.now(), saved);
    connection.spaceKey = spaceAt(map.spaces, player);
    if (arriving) {
      // Told to everyone already in this cohort; the arrival learns of itself
      // from the snapshot.
      broadcast(connection.cohortId, {
        type: 'joined',
        player: avatarOf(player, connection),
      });
    }

    // Registered before the old socket is closed: drop() decides whether the
    // avatar goes by asking whether the account still holds this cohort, so
    // this order is what keeps the replacement from removing it.
    const displaced = connections.add(connection);
    if (displaced) {
      app.log.info(
        {
          connectionId: displaced.id,
          replacedBy: connection.id,
          userId: connection.userId,
          cohortId: connection.cohortId,
        },
        'socket displaced, account entered this cohort elsewhere',
      );
      requests.replaced(displaced);
      send(displaced.socket, { type: 'replaced' });
      closeFor(displaced.socket, 'entered_elsewhere');
      // Only an idle tab replaced by an active one changes what is shown. Not
      // to the new tab, whose welcome has to come first: its snapshot says.
      if (displaced.availability.shown !== connection.availability.shown) {
        broadcast(
          connection.cohortId,
          {
            type: 'statusChanged',
            userId: connection.userId,
            status: connection.availability.shown,
          },
          connection,
        );
      }
    }

    presence.enter(connection);
    app.log.info(
      {
        connectionId: connection.id,
        userId: connection.userId,
        cohortId: connection.cohortId,
      },
      'socket opened',
    );
    attempt.outcome = 'opened';
    metrics.opened();
    annotate({ 'world.outcome': 'opened' });

    ws.on('pong', () => {
      connection.alive = true;
    });
    listen(connection);

    send(ws, {
      type: 'welcome',
      userId: connection.userId,
      connectionId: connection.id,
      heartbeatSeconds: env.WORLD_HEARTBEAT_SECONDS,
      stepMs: env.WORLD_STEP_MS,
      tickMs: env.WORLD_TICK_MS,
      awayAfterSeconds: env.WORLD_AWAY_AFTER_SECONDS,
      ...connection.appearance,
    });
    send(ws, {
      type: 'snapshot',
      map: {
        id: map.id,
        version: map.version,
        width: map.grid.width,
        height: map.grid.height,
      },
      players: appearance.avatarsIn(connection.cohortId),
      lockableSpaces: [...locks.lockableSpaces()],
      lockedSpaces: locks.lockedIn(connection.cohortId),
      spaces: [...doors.names()],
    });
    void calls.join(connection);
    void broadcastRoom.join(connection);
    requests.review(connection.cohortId, connection.spaceKey);

    // Handlers are on: whatever arrived during authentication is delivered
    // now, in the order it was sent.
    ws.resume();
  }

  function refuse(ws: WebSocket, refusal: Refusal): void {
    // The upgrade has already completed by the time Fastify hands the socket
    // over, so a refusal is a close rather than an HTTP status.
    app.log.info({ refusal }, 'socket refused');
    metrics.refused(refusal);
    annotate({ 'world.outcome': 'refused', 'world.refusal': refusal });
    // Paused during authentication; the closing handshake needs it back.
    ws.resume();
    send(ws, {
      type: 'error',
      code: ServerErrorCode.Unauthorized,
      message: refusal,
    });
    sendClose(ws, refusal);
  }
}

/** The seat an accepted upgrade asks for. */
function seatOf(decision: Extract<UpgradeDecision, { ok: true }>): Seat {
  return { userId: decision.claims.userId, cohortId: decision.cohortId };
}

/** A repeated parameter arrives as an array, which reads as none at all. */
function cohortIdFrom(query: unknown): string | undefined {
  if (typeof query !== 'object' || query === null) {
    return undefined;
  }
  const value = (query as Record<string, unknown>)[COHORT_QUERY_PARAM];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
