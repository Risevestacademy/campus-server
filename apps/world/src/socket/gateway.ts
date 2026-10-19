import { DEFAULT_SPACE_KEY } from '@campus/session';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

import type { AccountLookup, Appearance } from '../infra/accounts.js';
import type { Env } from '../infra/env.js';
import type {
  PositionStore,
  PositionToSave,
  SavedPosition,
} from '../infra/positions.js';
import type {
  Displacement,
  Presence,
  PresenceStore,
} from '../infra/presence.js';
import type { Tile } from '../movement/grid.js';
import { Players, type Player } from '../movement/players.js';
import { spaceAt } from '../movement/spaces.js';
import type { WorldMap } from '../movement/world-map.js';
import {
  decideUpgrade,
  sessionRefreshedSince,
  type Refusal,
} from './authenticate.js';
import { Connections, type Connection } from './connections.js';
import { COHORT_QUERY_PARAM, SOCKET_PATH } from './endpoint.js';
import { FrameBudget } from './frame-budget.js';
import { deliver } from './outbound.js';
import {
  ServerErrorCode,
  CLOSES,
  decode,
  encode,
  type Avatar,
  type CloseReason,
  type ServerMessage,
} from './protocol.js';

/**
 * Closes a socket for one of the reasons in CLOSES, with the code that goes
 * with it. A reason is all a caller names, so the code it is sent with and
 * what the schema tells clients about it can never disagree.
 */
function closeFor(socket: WebSocket, reason: CloseReason): void {
  socket.close(CLOSES[reason].code, reason);
}

export interface Gateway {
  connections: Connections;
  players: Players;
  /**
   * campus-api says this account's sprite or display name changed: read it
   * again, and tell their cohort if what to draw is different.
   */
  appearanceChanged(userId: string): Promise<void>;
  stop(): Promise<void>;
}

export function registerGateway(
  app: FastifyInstance,
  env: Env,
  accounts: AccountLookup,
  positions: PositionStore,
  presence: PresenceStore,
  map: WorldMap,
): Gateway {
  const connections = new Connections();
  const players = new Players(
    map.grid,
    env.WORLD_STEP_MS,
    env.WORLD_RECONNECT_GRACE_SECONDS * 1000,
  );

  /**
   * Who moved since the last tick, by account and cohort. Holds names, not
   * positions: the tick reads where each person stands when it runs, so
   * several steps in one tick collapse into the last.
   */
  const pendingMoves = new Map<string, Seat>();

  /**
   * Sends once per tick rather than once per step. Per step, every move is a
   * frame to every socket, so a room of n people walking costs n² frames a
   * step; per tick it is one frame per socket, however many moved.
   */
  function flushMoves(): void {
    if (pendingMoves.size === 0) {
      return;
    }
    // Grouped by cohort: each is its own campus, and a move is news only to
    // the people standing in the same one.
    const movedIn = new Map<string, Player[]>();
    for (const { userId, cohortId } of pendingMoves.values()) {
      const player = players.get(userId, cohortId);
      // Left since the step: `left` has already gone out, and an entry now
      // would put back an avatar the client has just taken away.
      if (!player || !connections.get(userId, cohortId)) continue;
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

  /**
   * Who has moved since their position was last written to the store, by
   * account and cohort. Not a position: the save reads where they stand when
   * it runs.
   */
  const unsaved = new Map<string, Seat>();
  /** Set once shutdown has written everybody, so the closes it causes do not write again. */
  let stopping = false;

  /**
   * Writes positions without holding anybody up. A failure only means the
   * position is not kept — see PositionStore — so it is logged, and anybody
   * still here is put back for the next periodic save to retry. Somebody who
   * has left cannot be retried that way: if the save as they left fails,
   * what was last written for them, at most one interval old, stands.
   */
  function persist(entries: readonly PositionToSave[]): void {
    if (entries.length === 0) return;
    positions.save(entries).catch((err: unknown) => {
      app.log.warn({ err, count: entries.length }, 'could not save positions');
      for (const { userId, cohortId } of entries) {
        // Retried only while the account is still in that cohort.
        if (connections.get(userId, cohortId)) {
          unsaved.set(seatKey(userId, cohortId), { userId, cohortId });
        }
      }
    });
  }

  /** Forgets one cohort's kept position, for access taken away. */
  function forgetSaved(userId: string, cohortId: string): void {
    unsaved.delete(seatKey(userId, cohortId));
    positions.forget(userId, cohortId).catch((err: unknown) => {
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
      const player = players.get(userId, cohortId);
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

  function presenceOf(connection: Connection): Presence {
    return {
      userId: connection.userId,
      connectionId: connection.id,
      cohortId: connection.cohortId,
      spaceKey: connection.spaceKey,
      since: connection.openedAt,
    };
  }

  /** A write found a newer connection holding this one's place. */
  function lostPlace(connection: Connection): void {
    displacedElsewhere({
      userId: connection.userId,
      connectionId: connection.id,
    });
  }

  /**
   * After a move to `tile`: if it is in another space, records the new one
   * in presence now, not at the next renewal. Skipped once shutdown has
   * begun, as it would undo shutdown's removal. A failed write is put right
   * by the next renewal, which carries the space too.
   */
  function recordSpaceCrossing(connection: Connection, tile: Tile): void {
    const spaceKey = spaceAt(map.spaces, tile);
    if (spaceKey === connection.spaceKey) return;
    connection.spaceKey = spaceKey;
    if (stopping) return;
    presence.changeSpace(presenceOf(connection)).then(
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
   * Entries this instance stops renewing lapse on their own, so a failure
   * here only leaves somebody looking online a little longer.
   */
  function leavePresence(leaving: readonly Connection[]): void {
    if (leaving.length === 0) return;
    presence.leave(leaving.map(presenceOf)).catch((err: unknown) => {
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
  presence.onDisplaced(displacedElsewhere);

  /**
   * Also how somebody comes back into presence after Redis was away, and how
   * a displacement whose message never arrived is caught.
   */
  async function renewPresence(): Promise<void> {
    const open = connections.all();
    if (open.length === 0) return;
    for (const displaced of await presence.renew(open.map(presenceOf))) {
      displacedElsewhere(displaced);
    }
  }

  const presenceRenewal = setInterval(
    oneAtATime(renewPresence, (err) => {
      app.log.warn({ err }, 'could not renew presence');
    }),
    (env.WORLD_PRESENCE_TTL_SECONDS * 1000) / 3,
  );
  presenceRenewal.unref();

  /**
   * Every way a socket stops counting goes through here, so a player can
   * never outlive the socket standing for them. Idempotent: a socket dropped
   * by the heartbeat comes back through here from its close event, and a
   * displaced one finds its replacement already holding the account's place
   * in that cohort.
   *
   * Where they stood is remembered for the reconnect grace, unless `remember`
   * is false — for access taken away, where a reconnect would be refused
   * anyway and there is nothing to come back to. The avatar leaves everybody
   * else's screen either way: a frozen stand-in for somebody who may never
   * return is worse than a flicker for somebody who does.
   */
  function drop(connection: Connection, remember = true): void {
    // A connection displaced here no longer holds the account's presence;
    // after shutdown began, everybody has been removed already.
    if (connections.has(connection) && !stopping) {
      leavePresence([connection]);
    }
    connections.remove(connection);
    // Replaced in the same cohort: the avatar stays, and the new socket
    // stands for it. Their places in other cohorts are none of this.
    if (connections.get(connection.userId, connection.cohortId)) {
      return;
    }
    const seat = seatKey(connection.userId, connection.cohortId);
    const standing = players.get(connection.userId, connection.cohortId);
    if (
      players.leave(
        connection.userId,
        connection.cohortId,
        Date.now(),
        remember,
      )
    ) {
      // With them goes any step of theirs the tick has not sent yet: should
      // they be back before it runs, `joined` already says where they stand.
      pendingMoves.delete(seat);
      broadcast(connection.cohortId, {
        type: 'left',
        userId: connection.userId,
      });
    }
    // Kept for the next visit only when they may come back; after shutdown
    // began, everybody has been written already. Access taken away forgets
    // this connection's cohort: there is nothing to come back to.
    if (!remember) {
      forgetSaved(connection.userId, connection.cohortId);
    } else if (standing && !stopping) {
      unsaved.delete(seat);
      persist([positionOf(standing, connection.cohortId)]);
    }
  }

  /**
   * For arrivals and departures, which are rare enough to send at once. Only
   * to the cohort it happened in: each cohort is its own campus, and nobody
   * in one sees or hears of anybody in another, though they share this
   * process and the one map it loaded.
   */
  function broadcast(cohortId: string, message: ServerMessage): void {
    const frame = encode(message);
    for (const connection of connections.all()) {
      if (connection.cohortId === cohortId) {
        sendFrame(connection.socket, frame);
      }
    }
  }

  /**
   * Puts the account's sprite and name on one of its sockets, and tells that
   * socket's cohort, itself included, when they differ from what was being
   * drawn there. Only for a socket that still holds the account's place in
   * its cohort: the read crossed an await, and a socket replaced meanwhile
   * has nobody left to tell.
   */
  function showAppearance(connection: Connection, account: Appearance): void {
    if (!connections.has(connection)) {
      return;
    }
    const { displayName, spriteKey } = account;
    if (
      connection.appearance.displayName === displayName &&
      connection.appearance.spriteKey === spriteKey
    ) {
      return;
    }
    connection.appearance = { displayName, spriteKey };
    broadcast(connection.cohortId, {
      type: 'appearance',
      userId: connection.userId,
      displayName,
      spriteKey,
    });
  }

  /** Everybody standing in one cohort's campus, with what to draw for them. */
  function avatarsIn(cohortId: string): Avatar[] {
    return players.in(cohortId).flatMap((player) => {
      const connection = connections.get(player.userId, cohortId);
      return connection ? [avatarOf(player, connection)] : [];
    });
  }

  /**
   * Checked once per heartbeat rather than per frame: a ban, or the end of a
   * guest's visit, should take effect in seconds, and asking the database on
   * every message would put a query in the path of every movement. One query
   * per account, however many cohorts it has sockets in, plus one for the
   * cohort membership behind every socket that is not an admin's.
   */
  async function dropUnwelcome(): Promise<void> {
    const now = new Date();
    const byAccount = new Map<string, Connection[]>();
    for (const connection of connections.all()) {
      const open = byAccount.get(connection.userId);
      if (open) open.push(connection);
      else byAccount.set(connection.userId, [connection]);
    }

    for (const [userId, open] of byAccount) {
      let account;
      try {
        account = await accounts.find(userId);
      } catch (err) {
        // A database that is not answering must not throw everybody off the
        // campus; the next sweep tries again.
        app.log.error({ err, userId }, 'could not re-check account');
        continue;
      }
      if (account && !account.suspended) {
        for (const connection of open) {
          dropIfRevoked(connection, account.sessionEpoch);
          // The account was read anyway. A change whose notification this
          // process missed, while it was reconnecting to the database, is
          // caught here, a heartbeat late at worst.
          showAppearance(connection, account);
          // The cohort is asked again for everybody but an admin, who is
          // admitted on their role alone — from the row, as at the upgrade,
          // so a demotion lands on the socket already open too.
          if (!account.admin) {
            await dropIfNotMember(connection, now);
          }
        }
        continue;
      }

      // The account itself is not welcome, so neither is any socket it holds,
      // in any cohort.
      const reason = account ? 'account_suspended' : 'account_gone';
      for (const connection of open) {
        app.log.info(
          {
            connectionId: connection.id,
            userId,
            cohortId: connection.cohortId,
            reason,
          },
          'closing socket, account no longer welcome',
        );
        drop(connection, false);
        closeFor(connection.socket, reason);
      }
    }
  }

  /**
   * Closes a socket that was opened before its account's sessions were
   * revoked. The upgrade refuses a revoked token; this is what reaches the
   * socket already open, which would otherwise stay until the login stopped
   * being refreshed.
   *
   * Only one that is behind the account's epoch. Somebody who signed in
   * again after the revoke opened on the new epoch, and is as current as it
   * gets.
   *
   * And only one that still holds the account's place in its cohort. The
   * account was read across an await, and in that time a newer socket in the
   * same cohort may have displaced this one — which has then been told
   * `replaced` and closed already, and has nothing left to drop.
   */
  function dropIfRevoked(connection: Connection, sessionEpoch: number): void {
    if (connection.epoch === sessionEpoch || !connections.has(connection)) {
      return;
    }
    app.log.info(
      { connectionId: connection.id, userId: connection.userId },
      'session revoked, closing socket',
    );
    // Remembered, like a sign-out: the account is still welcome, and signing
    // back in may resume where they stood.
    drop(connection);
    closeFor(connection.socket, 'session_revoked');
  }

  /**
   * The cohort this socket named, asked again. The upgrade asks once, and
   * nothing behind the socket keeps that answer true: a guest's visit has an
   * end date, and neither the access token the socket opened with nor the
   * login it follows runs out with it. So a membership that ends while the
   * socket is open has to reach that socket, within one heartbeat.
   *
   * Admins are excepted by the caller, as they are at the upgrade.
   *
   * And only one that still holds the account's place in its cohort, for the
   * same reason as dropIfRevoked: the read crosses awaits, and in that time a
   * newer socket may have displaced this one — which has then been told
   * `replaced` and closed already.
   */
  async function dropIfNotMember(
    connection: Connection,
    now: Date,
  ): Promise<void> {
    let live: boolean;
    try {
      live = await accounts.liveMembership(
        connection.userId,
        connection.cohortId,
        now,
      );
    } catch (err) {
      // As with the account: a database that is not answering must not throw
      // everybody off the campus. The next sweep tries again.
      app.log.error(
        { err, userId: connection.userId, cohortId: connection.cohortId },
        'could not re-check membership',
      );
      return;
    }
    if (live || !connections.has(connection)) {
      return;
    }

    app.log.info(
      {
        connectionId: connection.id,
        userId: connection.userId,
        cohortId: connection.cohortId,
      },
      'membership ended, closing socket',
    );
    // Remembered, unlike a suspension: a visit may be extended, or the account
    // may belong here again, and then signing back in resumes where they
    // stood rather than starting over. The same reason an upgrade refused for
    // this leaves the kept position alone.
    drop(connection);
    closeFor(connection.socket, 'not_a_member');
  }

  /**
   * An access token lasts fifteen minutes and the browser swaps it for a new
   * one through campus-api, which an open socket never sees. So a socket
   * follows the login instead: it stays while that login is live — not
   * signed out, and refreshed recently, which means campus-api has re-checked
   * suspension and access within the window. One query for every socket.
   */
  async function dropEndedSessions(): Promise<void> {
    const following = connections
      .all()
      .filter((c) => c.sessionId !== undefined);
    if (following.length === 0) {
      return;
    }
    const now = new Date();
    let live: Set<string>;
    try {
      live = await accounts.liveSessions(
        following.map((c) => c.sessionId as string),
        sessionRefreshedSince(env, now),
        now,
      );
    } catch (err) {
      // As with accounts: a database that is not answering must not throw
      // everybody off the campus. The next sweep tries again.
      app.log.error({ err }, 'could not re-check sessions');
      return;
    }

    for (const connection of following) {
      if (live.has(connection.sessionId as string)) {
        continue;
      }
      app.log.info(
        { connectionId: connection.id, userId: connection.userId },
        'session ended, closing socket',
      );
      // Remembered: signing out is not access being taken away, and signing
      // straight back in may resume where they stood.
      drop(connection);
      closeFor(connection.socket, 'session_ended');
    }
  }

  /**
   * One of each sweep at a time. The heartbeat does not wait for them, so a
   * database slower than the interval would otherwise stack queries on the
   * pool, and let an older check land after a newer one. A heartbeat that
   * finds its sweep still running skips it; the next one runs with fresh
   * state.
   */
  const sweepFailed = (err: unknown): void => {
    app.log.error({ err }, 'heartbeat sweep failed');
  };
  const sweepUnwelcome = oneAtATime(dropUnwelcome, sweepFailed);
  const sweepSessions = oneAtATime(dropEndedSessions, sweepFailed);

  const heartbeat = setInterval(() => {
    sweepUnwelcome();
    sweepSessions();
    const now = Date.now();
    players.forgetExpired(now);
    for (const connection of connections.all()) {
      // A socket that names no login has only its access token to go on, so
      // it lasts exactly as long as that token does — otherwise signing out,
      // or simply waiting, would leave the campus open with nothing to end
      // it. A socket that names one follows the login (dropEndedSessions).
      if (
        connection.sessionId === undefined &&
        connection.expiresAt.getTime() <= now
      ) {
        app.log.info(
          { connectionId: connection.id, userId: connection.userId },
          'session expired, closing socket',
        );
        // Dropped from the registry here rather than when the close event
        // comes back, so nothing is counted as present once we have decided
        // it is not. Removal is idempotent, so the close handler is fine.
        drop(connection);
        closeFor(connection.socket, 'session_expired');
        continue;
      }

      if (!connection.alive) {
        // Missed the last round trip: the socket is open as far as this
        // process knows, and gone as far as anybody else is concerned.
        app.log.info(
          { connectionId: connection.id, userId: connection.userId },
          'socket failed heartbeat, closing',
        );
        drop(connection);
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
  }, env.WORLD_HEARTBEAT_SECONDS * 1000);
  // Never hold the process open for a heartbeat.
  heartbeat.unref();

  // The handler returns its promise so @fastify/websocket can catch a
  // rejection; returning undefined would turn one bad socket into an
  // unhandled rejection that takes the whole process down.
  app.get(SOCKET_PATH, { websocket: true }, async (socket, request) => {
    await openConnection(
      socket,
      {
        origin: request.headers.origin,
        cookie: request.headers.cookie,
        authorization: request.headers.authorization,
      },
      cohortIdFrom(request.query),
    );
  });

  async function openConnection(
    ws: WebSocket,
    headers: { origin?: string; cookie?: string; authorization?: string },
    cohortId: string | undefined,
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
    const onClose = (): void => {
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
      // Reading has to resume for the closing handshake to complete.
      ws.resume();
      closeFor(ws, 'internal_error');
      return;
    }

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
        forgetSaved(userId, cohortId);
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
        players.leave(userId, cohortId, Date.now(), false);
      }
    }

    // Where they stood on an earlier visit to this cohort, read before the
    // socket is checked again: the read is asynchronous too, and the socket
    // may go in the meantime. Skipped when this process will resume a
    // position in this same cohort — another tab, or a reconnect within the
    // grace. What the account holds in other cohorts has no bearing on it.
    let saved: SavedPosition | undefined;
    if (
      decision.ok &&
      !players.has(decision.claims.userId, decision.cohortId) &&
      !players.isRemembered(decision.claims.userId, decision.cohortId)
    ) {
      try {
        saved = await positions.load(decision.claims.userId, decision.cohortId);
      } catch (err) {
        app.log.warn(
          { err, userId: decision.claims.userId },
          'could not load saved position, starting at the spawn',
        );
      }
    }

    if (closed || ws.readyState !== ws.OPEN) {
      return;
    }

    if (!decision.ok) {
      refuse(ws, decision.refusal);
      return;
    }

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
    const arriving = !players.has(connection.userId, connection.cohortId);
    const player = players.join(
      connection.userId,
      connection.cohortId,
      Date.now(),
      saved,
    );
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
      send(displaced.socket, { type: 'replaced' });
      closeFor(displaced.socket, 'entered_elsewhere');
    }

    // A newer connection to this cohort on another instance may have reached
    // Redis first; it holds the place, and this one closes as if displaced.
    presence.enter(presenceOf(connection)).then(
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
    app.log.info(
      {
        connectionId: connection.id,
        userId: connection.userId,
        cohortId: connection.cohortId,
      },
      'socket opened',
    );

    ws.on('pong', () => {
      connection.alive = true;
    });

    const budget = new FrameBudget(
      env.WORLD_MAX_MESSAGES_PER_SECOND,
      Date.now(),
    );

    ws.on('message', (raw: Buffer) => {
      // A socket we have dropped can still deliver frames while its close
      // handshake finishes. It no longer speaks for anybody — and its player
      // may be gone, which a move would trip over.
      if (!connections.has(connection)) {
        return;
      }
      // Before parsing, so an excess frame costs only a counter. Closing
      // makes the client reconnect to an authoritative snapshot instead of
      // silently losing a predicted move.
      const admission = budget.admit(Date.now());
      if (admission === 'close') {
        app.log.warn(
          { connectionId: connection.id, userId: connection.userId },
          'socket sending too fast, closing',
        );
        drop(connection);
        closeFor(connection.socket, 'rate_limited');
        return;
      }
      // Frames over WORLD_MAX_MESSAGE_BYTES never arrive: ws enforces
      // maxPayload itself and closes with 1009 before this fires.
      const result = decode(raw.toString('utf8'));
      if (!result.ok) {
        send(ws, {
          type: 'error',
          code: ServerErrorCode.BadMessage,
          message: result.reason,
        });
        return;
      }

      switch (result.message.type) {
        case 'ping':
          connection.alive = true;
          send(ws, { type: 'pong' });
          return;
        case 'move': {
          const { direction, seq } = result.message;
          const moved = players.move(
            connection.userId,
            connection.cohortId,
            direction,
            Date.now(),
          );
          send(ws, {
            type: 'moveResult',
            seq,
            outcome: moved.outcome,
            player: moved.player,
          });
          if (moved.outcome === 'moved') {
            recordSpaceCrossing(connection, moved.player);
          }
          if (moved.changed) {
            const seat = {
              userId: connection.userId,
              cohortId: connection.cohortId,
            };
            const key = seatKey(seat.userId, seat.cohortId);
            pendingMoves.set(key, seat);
            unsaved.set(key, seat);
          }
          return;
        }
      }
    });

    send(ws, {
      type: 'welcome',
      userId: connection.userId,
      connectionId: connection.id,
      heartbeatSeconds: env.WORLD_HEARTBEAT_SECONDS,
      stepMs: env.WORLD_STEP_MS,
      tickMs: env.WORLD_TICK_MS,
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
      players: avatarsIn(connection.cohortId),
    });

    // Handlers are on: whatever arrived during authentication is delivered
    // now, in the order it was sent.
    ws.resume();
  }

  function refuse(ws: WebSocket, refusal: Refusal): void {
    // The upgrade has already completed by the time Fastify hands the socket
    // over, so a refusal is a close rather than an HTTP status.
    app.log.info({ refusal }, 'socket refused');
    // Paused during authentication; the closing handshake needs it back.
    ws.resume();
    send(ws, {
      type: 'error',
      code: ServerErrorCode.Unauthorized,
      message: refusal,
    });
    closeFor(ws, refusal);
  }

  function send(ws: WebSocket, message: ServerMessage): void {
    sendFrame(ws, encode(message));
  }

  function sendFrame(ws: WebSocket, frame: string): void {
    const bufferedBytes = ws.bufferedAmount;
    if (deliver(ws, frame, env.WORLD_MAX_BUFFERED_BYTES) === 'lagging') {
      app.log.warn({ bufferedBytes }, 'socket not reading, terminating');
    }
  }

  return {
    connections,
    players,
    async appearanceChanged(userId: string): Promise<void> {
      if (connections.forUser(userId).length === 0) {
        return; // Not on this process's campus: nobody here to tell.
      }
      let account;
      try {
        account = await accounts.find(userId);
      } catch (err) {
        // The heartbeat reads the account again and catches it then.
        app.log.error({ err, userId }, 'could not re-read a changed profile');
        return;
      }
      if (account) {
        // Every cohort they are standing in is told, each once.
        for (const connection of connections.forUser(userId)) {
          showAppearance(connection, account);
        }
      }
    },
    async stop(): Promise<void> {
      clearInterval(heartbeat);
      clearInterval(tick);
      clearInterval(periodicSave);
      clearInterval(presenceRenewal);
      // Everybody still here, whether or not they moved since the last save:
      // a redeploy should put nobody back at the spawn. Before the sockets
      // close, so the positions written are the ones they stood at.
      stopping = true;
      unsaved.clear();
      try {
        await positions.save(
          connections.all().flatMap((connection) => {
            const player = players.get(connection.userId, connection.cohortId);
            return player ? [positionOf(player, connection.cohortId)] : [];
          }),
        );
      } catch (err) {
        app.log.warn({ err }, 'could not save positions on shutdown');
      }
      try {
        await presence.leave(connections.all().map(presenceOf));
      } catch (err) {
        app.log.warn({ err }, 'could not remove presence on shutdown');
      }
      for (const connection of connections.all()) {
        closeFor(connection.socket, 'server shutting down');
      }
    },
  };
}

/** An account's place in one cohort: what avatars, moves and saves are kept by. */
interface Seat {
  userId: string;
  cohortId: string;
}

function seatKey(userId: string, cohortId: string): string {
  return `${cohortId}\u0000${userId}`;
}

function avatarOf(player: Player, connection: Connection): Avatar {
  return { ...player, ...connection.appearance };
}

/** A store write for one player, in the cohort named. */
function positionOf(player: Player, cohortId: string): PositionToSave {
  return {
    userId: player.userId,
    cohortId,
    x: player.x,
    y: player.y,
    facing: player.facing,
  };
}

/** A repeated parameter arrives as an array, which reads as none at all. */
function cohortIdFrom(query: unknown): string | undefined {
  if (typeof query !== 'object' || query === null) {
    return undefined;
  }
  const value = (query as Record<string, unknown>)[COHORT_QUERY_PARAM];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Wraps an async task so that calling it while a previous call is still
 * running does nothing. A failure goes to `onError` rather than becoming an
 * unhandled rejection, which would take the process down; the guard is
 * released either way, so one bad run does not stop the next.
 */
export function oneAtATime(
  task: () => Promise<void>,
  onError: (err: unknown) => void,
): () => void {
  let running = false;
  return () => {
    if (running) {
      return;
    }
    running = true;
    task()
      .catch(onError)
      .finally(() => {
        running = false;
      });
  };
}
