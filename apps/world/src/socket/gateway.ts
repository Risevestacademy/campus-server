import {
  broadcastRoomName,
  microphoneMuter,
  mintRoomToken,
  participantIdentity,
  participantRemover,
  spaceRoomName,
  type MuteResult,
} from '@campus/media';
import { DEFAULT_SPACE_KEY, hasAdminPowers } from '@campus/session';
import {
  COHORT_ROLES,
  SPACE_ACCESS,
  mayEnter,
  type CohortMembershipFacts,
  type PersonFacts,
  type SpaceFacts,
} from '@campus/space-access';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

import {
  DEFAULT_SUBSCRIBE_RADIUS,
  type Account,
  type AccountLookup,
  type Appearance,
  type WorldSpace,
} from '../infra/accounts.js';
import { mediaCredentials, type Env } from '../infra/env.js';
import { worldMetrics } from '../infra/metrics.js';
import { annotate, traced } from '../infra/traced.js';
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
import { seatKey, type Seat } from '../seat.js';
import { SpaceLocks, lockableKeys } from '../spaces/locks.js';
import { SpaceRemovals, nearestOutside } from '../spaces/removals.js';
import {
  EntryRequests,
  besideSpace,
  obstacle,
  takesRequests,
  type EntryRequest,
  type Obstacle,
  type RequestFacts,
} from '../spaces/requests.js';
import { Availability, Status } from '../status/availability.js';
import {
  decideUpgrade,
  sessionRefreshedSince,
  type Refusal,
  type UpgradeDecision,
} from './authenticate.js';
import { Connections, type CallSpec, type Connection } from './connections.js';
import { SayBudget, inEarshot, type Hearing } from './earshot.js';
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
  type EntryRequestOutcome,
  type ServerMessage,
} from './protocol.js';

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

/** The cohort roles that moderate a designated space whose list names them. */
const STAFF_ROLES = new Set<string>([
  COHORT_ROLES.Professor,
  COHORT_ROLES.Mentor,
]);

/**
 * Closes a socket for one of the reasons in CLOSES, with the code that goes
 * with it. A reason is all a caller names, so the code it is sent with and
 * what the schema tells clients about it can never disagree.
 */
function sendClose(socket: WebSocket, reason: CloseReason): void {
  socket.close(CLOSES[reason].code, reason);
}

/** How one upgrade ended, counted once, whichever way it ends. */
interface Attempt {
  outcome?: 'opened' | 'refused' | 'failed' | 'abandoned';
}

export interface Gateway {
  connections: Connections;
  players: Players;
  /**
   * campus-api says this account's sprite or display name changed: read it
   * again, and tell their cohort if what to draw is different.
   */
  appearanceChanged(userId: string): Promise<void>;
  /**
   * campus-api says something a space's door reads has changed: read every
   * space on the map again. Resolves once the doors answer from it.
   */
  spacesChanged(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Stops the gauges reading the sockets. Not part of stop(), so the final
   * flush after it still reads the last counts.
   */
  dispose(): void;
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
  const metrics = worldMetrics(connections);

  function closeFor(socket: WebSocket, reason: CloseReason): void {
    metrics.closedByServer(reason);
    sendClose(socket, reason);
  }
  const players = new Players(
    map.grid,
    env.WORLD_STEP_MS,
    env.WORLD_RECONNECT_GRACE_SECONDS * 1000,
  );

  /**
   * Every space on this map as the database last said, by key: what each
   * door decides from. Read whole, at boot, whenever campus-api says a space
   * or a list changed, and every heartbeat in case that word went missing.
   * A read that fails keeps what the doors had.
   */
  let doors: ReadonlyMap<string, WorldSpace> = new Map();
  /** Whether a read has ever succeeded, so a missing key means no row. */
  let doorsRead = false;
  let doorsLoading: Promise<void> | undefined;
  let readDoorsAgain = false;

  const locks = new SpaceLocks();
  const removals = new SpaceRemovals();
  /** Which spaces may be locked, from the doors last read, sorted. */
  let lockable: readonly string[] = [];

  /**
   * One read at a time. Asked again while one is running, the running one
   * reads once more when it is done, so a change that lands mid-read is
   * never left behind; everybody asking waits for the same read.
   */
  function reloadDoors(): Promise<void> {
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
          refreshCalls();
          refreshLockable();
          reviewRequests();
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

  const doorsReady = reloadDoors().then(() => {
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

  /**
   * Whether this socket's person may step into a space, at `now`. The map's
   * default space is the way to everywhere else and the database keeps it
   * normal, so it is never asked about.
   */
  function mayStepInto(
    connection: Connection,
    spaceKey: string,
    now: Date,
  ): boolean {
    if (spaceKey === DEFAULT_SPACE_KEY) {
      return true;
    }
    if (removals.isRemoved(connection, spaceKey, now.getTime())) {
      return false;
    }
    const space =
      doors.get(spaceKey) ?? (doorsRead ? NOT_YET_SYNCED : NOT_YET_READ);
    return mayEnter(
      personOf(connection),
      locks.isLocked(connection.cohortId, spaceKey)
        ? { ...space, locked: true }
        : space,
      now,
    );
  }

  /**
   * After the spaces are read: tells everybody when the lockable spaces have
   * changed, and ends the locks on any that can no longer be locked.
   */
  function refreshLockable(): void {
    if (stopping) return;
    const next = lockableKeys(doors);
    if (
      next.length !== lockable.length ||
      next.some((key, i) => key !== lockable[i])
    ) {
      lockable = next;
      const frame = encode({ type: 'lockableSpaces', spaceKeys: next });
      for (const connection of connections.all()) {
        sendFrame(connection.socket, frame);
      }
    }
    for (const { cohortId, spaceKey } of locks.all()) {
      if (!lockable.includes(spaceKey)) unlock(cohortId, spaceKey, null);
    }
  }

  function setLock(connection: Connection, locked: boolean): void {
    const { cohortId, spaceKey, userId } = connection;
    if (!lockable.includes(spaceKey)) {
      send(connection.socket, {
        type: 'error',
        code: ServerErrorCode.NotAllowed,
        message: 'this space cannot be locked',
      });
      return;
    }
    if (!locked) {
      unlock(cohortId, spaceKey, userId);
    } else if (locks.lock(cohortId, spaceKey)) {
      broadcast(cohortId, { type: 'lockChanged', spaceKey, locked, userId });
    }
  }

  /** `userId` is who unlocked it, or null when the lock ended on its own. */
  function unlock(
    cohortId: string,
    spaceKey: string,
    userId: string | null,
  ): void {
    if (locks.unlock(cohortId, spaceKey)) {
      broadcast(cohortId, {
        type: 'lockChanged',
        spaceKey,
        locked: false,
        userId,
      });
      reviewRequests(cohortId, spaceKey);
    }
  }

  /** A lock ends when the last person in that cohort's copy of the space leaves. */
  function unlockIfEmpty(cohortId: string, spaceKey: string): void {
    if (
      locks.isLocked(cohortId, spaceKey) &&
      !connections
        .all()
        .some(
          (connection) =>
            connection.cohortId === cohortId &&
            connection.spaceKey === spaceKey,
        )
    ) {
      unlock(cohortId, spaceKey, null);
    }
  }

  const requests = new EntryRequests<Connection>();

  const REFUSALS: Record<Obstacle, string> = {
    may_walk_in: 'you may walk in',
    no_requests: 'this space takes no requests',
    not_beside: 'ask from beside the space',
    nobody_inside: 'nobody inside can answer',
  };
  const ENDINGS: Record<Obstacle, EntryRequestOutcome> = {
    may_walk_in: 'not_needed',
    no_requests: 'cancelled',
    not_beside: 'walked_away',
    nobody_inside: 'nobody_inside',
  };

  /** Somebody staff removed from a normal space finds it locked to them alone, so they may ask. */
  function spaceTakesRequests(
    connection: Connection,
    spaceKey: string,
  ): boolean {
    return takesRequests(
      doors.get(spaceKey),
      locks.isLocked(connection.cohortId, spaceKey) ||
        removals.isRemoved(connection, spaceKey, Date.now()),
    );
  }

  /**
   * Anybody inside a locked space may answer, somebody let in included; in
   * a designated one, only somebody its list names, or an admin, not a
   * visitor let in.
   */
  function mayAnswer(
    connection: Connection,
    spaceKey: string,
    now: Date,
  ): boolean {
    const space = doors.get(spaceKey);
    if (!space || connection.spaceKey !== spaceKey) return false;
    return (
      space.access !== SPACE_ACCESS.Designated ||
      mayEnter(personOf(connection), { ...space, locked: false }, now)
    );
  }

  function answerersIn(
    cohortId: string,
    spaceKey: string,
    now: Date,
  ): Connection[] {
    return connections
      .all()
      .filter(
        (connection) =>
          connection.cohortId === cohortId &&
          mayAnswer(connection, spaceKey, now),
      );
  }

  function requestFacts(
    connection: Connection,
    spaceKey: string,
    now: Date,
  ): RequestFacts {
    const player = players.get(connection);
    return {
      mayWalkIn: mayStepInto(connection, spaceKey, now),
      takesRequests: spaceTakesRequests(connection, spaceKey),
      beside:
        player !== undefined &&
        besideSpace(map.grid, map.spaces, player, spaceKey),
      answerers: answerersIn(connection.cohortId, spaceKey, now).length,
    };
  }

  /** A yes not yet walked through, while the space still takes requests. */
  function hasPass(connection: Connection, spaceKey: string): boolean {
    return (
      requests.passFor(connection) === spaceKey &&
      spaceTakesRequests(connection, spaceKey)
    );
  }

  function whyNotAsk(
    connection: Connection,
    spaceKey: string,
    now: Date,
  ): string | null {
    if (spaceKey !== DEFAULT_SPACE_KEY && !map.spaces.keys.includes(spaceKey)) {
      return 'no such space';
    }
    if (spaceKey === connection.spaceKey) return 'you are inside it already';
    if (hasPass(connection, spaceKey)) return REFUSALS.may_walk_in;
    const found = obstacle(requestFacts(connection, spaceKey, now));
    return found && REFUSALS[found];
  }

  function requestEntry(connection: Connection, spaceKey: string): void {
    const now = new Date();
    let refusal = whyNotAsk(connection, spaceKey, now);
    if (!refusal) {
      const asked = requests.ask(
        connection,
        spaceKey,
        now.getTime(),
        connection,
      );
      if (asked === 'already_asking') {
        refusal = 'you have a request open already';
      } else if (asked === 'too_soon') {
        refusal = 'asked again too soon after a no';
      }
    }
    if (refusal) {
      send(connection.socket, {
        type: 'error',
        code: ServerErrorCode.NotAllowed,
        message: refusal,
      });
      return;
    }
    send(connection.socket, {
      type: 'entryRequested',
      requestId: (requests.openFor(connection) as EntryRequest<Connection>).id,
      userId: connection.userId,
      spaceKey,
    });
    reviewRequests(connection.cohortId, spaceKey);
  }

  /** By the request's id, not the asker's: a late answer never reaches a newer request. */
  function answerEntryRequest(
    connection: Connection,
    requestId: string,
    admit: boolean,
  ): void {
    const now = new Date();
    const request = requests.find(requestId);
    if (
      !request ||
      request.cohortId !== connection.cohortId ||
      !mayAnswer(connection, request.spaceKey, now)
    ) {
      send(connection.socket, {
        type: 'error',
        code: ServerErrorCode.NotAllowed,
        message: 'no request here for you to answer',
      });
      return;
    }
    if (admit) requests.admit(request);
    else requests.decline(request, now.getTime());
    announceEnded(request, admit ? 'admitted' : 'declined', connection.userId);
  }

  function withdrawEntryRequest(
    connection: Connection,
    requestId: string,
  ): void {
    if (requests.openFor(connection)?.id !== requestId) {
      send(connection.socket, {
        type: 'error',
        code: ServerErrorCode.NotAllowed,
        message: 'no open request of yours to withdraw',
      });
      return;
    }
    endRequest(connection, 'withdrawn');
  }

  function endRequest(seat: Seat, outcome: EntryRequestOutcome): void {
    const request = requests.close(seat);
    if (request) announceEnded(request, outcome, null);
  }

  /** The asker is told even once replaced: its socket is still open, and it asked. */
  function announceEnded(
    request: EntryRequest<Connection>,
    outcome: EntryRequestOutcome,
    answeredBy: string | null,
  ): void {
    const frame = encode({
      type: 'entryRequestEnded',
      requestId: request.id,
      userId: request.userId,
      spaceKey: request.spaceKey,
      outcome,
      answeredBy,
    });
    if (request.asker.socket.readyState === request.asker.socket.OPEN) {
      sendFrame(request.asker.socket, frame);
    }
    for (const connection of request.told) {
      if (connection !== request.asker && connections.has(connection)) {
        sendFrame(connection.socket, frame);
      }
    }
  }

  /**
   * After anything that changes who may enter or answer: ends the requests
   * no longer needed or answerable, sends the rest to anybody inside who may
   * answer and has not been sent them, and drops the yeses no longer good.
   */
  function reviewRequests(cohortId?: string, spaceKey?: string): void {
    if (stopping) return;
    const now = new Date();
    for (const request of requests.all(cohortId, spaceKey)) {
      if (connections.holderOf(request) !== request.asker) {
        endRequest(request, 'withdrawn');
        continue;
      }
      const found = obstacle(
        requestFacts(request.asker, request.spaceKey, now),
      );
      if (found) {
        endRequest(request, ENDINGS[found]);
        continue;
      }
      const frame = encode({
        type: 'entryRequested',
        requestId: request.id,
        userId: request.userId,
        spaceKey: request.spaceKey,
      });
      for (const answerer of answersIn(request, now)) {
        request.told.add(answerer);
        sendFrame(answerer.socket, frame);
      }
    }
    // Nobody inside does not undo a yes: it was given while somebody was.
    for (const pass of requests.allPasses(cohortId, spaceKey)) {
      const holder = connections.holderOf(pass);
      const found =
        holder && obstacle(requestFacts(holder, pass.spaceKey, now));
      if (!holder || (found && found !== 'nobody_inside')) {
        requests.dropPass(pass);
      }
    }
  }

  /** Those inside who may answer a request and have not been sent it. */
  function answersIn(
    request: EntryRequest<Connection>,
    now: Date,
  ): Connection[] {
    return answerersIn(request.cohortId, request.spaceKey, now).filter(
      (answerer) => !request.told.has(answerer),
    );
  }

  /** After a step: leaving the tiles beside a space ends a request to it, and lets a yes lapse. */
  function leaveTheDoor(connection: Connection, tile: Tile): void {
    const request = requests.openFor(connection);
    if (request && !besideSpace(map.grid, map.spaces, tile, request.spaceKey)) {
      endRequest(connection, 'walked_away');
    }
    const pass = requests.passFor(connection);
    if (
      pass !== undefined &&
      (connection.spaceKey === pass ||
        !besideSpace(map.grid, map.spaces, tile, pass))
    ) {
      requests.dropPass(connection);
    }
  }

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
    const touched = new Set(nearbyStale);
    nearbyStale.clear();
    for (const { cohortId } of pendingMoves.values()) touched.add(cohortId);
    sendMoves();
    if (!media || touched.size === 0) return;
    const byCohort = new Map<string, Connection[]>();
    for (const connection of connections.all()) {
      if (!touched.has(connection.cohortId)) continue;
      const inCohort = byCohort.get(connection.cohortId);
      if (inCohort) inCohort.push(connection);
      else byCohort.set(connection.cohortId, [connection]);
    }
    for (const inCohort of byCohort.values()) updateNearby(inCohort);
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

  const media = mediaCredentials(env);
  const removeFromCall = media ? participantRemover(media) : undefined;
  const muteMicrophone = media ? microphoneMuter(media) : undefined;
  /** Cohorts whose `nearby` lists may be out of date though nobody moved. */
  const nearbyStale = new Set<string>();

  /** The call the space a socket stands in has, or null where it has none. */
  function callFor(connection: Connection): CallSpec | null {
    const space = doors.get(connection.spaceKey);
    if (!space) return null;
    let room: string;
    try {
      room = spaceRoomName({
        cohortId: connection.cohortId,
        spaceId: space.id,
      });
    } catch {
      return null;
    }
    return {
      room,
      hearing: space.audioMode === 'proximity' ? 'proximity' : 'room',
      audibleRadius: space.audibleRadius,
      subscribeRadius: space.subscribeRadius,
    };
  }

  function sameCall(a: CallSpec | null, b: CallSpec | undefined): boolean {
    if (!a || !b) return !a && !b;
    return (
      a.room === b.room &&
      a.hearing === b.hearing &&
      a.audibleRadius === b.audibleRadius &&
      a.subscribeRadius === b.subscribeRadius
    );
  }

  /**
   * Removals LiveKit has not yet confirmed, by room and identity: kept until
   * one succeeds, and tried again at every heartbeat, so somebody who left a
   * room, or lost the right to speak in one, is never left in it.
   */
  const pendingRemovals = new Map<string, { room: string; identity: string }>();
  const removing = new Set<string>();

  /** Takes an identity out of a room, revoking its tokens; retried until LiveKit confirms. */
  function removeFromRoom(room: string, identity: string): void {
    if (!removeFromCall) return;
    const key = `${room}\u0000${identity}`;
    pendingRemovals.set(key, { room, identity });
    if (removing.has(key)) return;
    removing.add(key);
    removeFromCall(room, identity)
      .then(
        () => pendingRemovals.delete(key),
        (err: unknown) => {
          app.log.warn(
            { err, room },
            'could not take somebody out of a room, trying again at the heartbeat',
          );
        },
      )
      .finally(() => removing.delete(key));
  }

  function retryRemovals(): void {
    for (const { room, identity } of pendingRemovals.values()) {
      removeFromRoom(room, identity);
    }
  }

  function leaveCall(connection: Connection): void {
    const call = connection.call;
    if (!call) return;
    connection.call = undefined;
    removeFromRoom(call.room, call.identity);
  }

  /** Hands the socket the call for the space it stands in, after taking it out of the last one. */
  async function joinCall(connection: Connection): Promise<void> {
    if (!media) return;
    leaveCall(connection);
    nearbyStale.add(connection.cohortId);
    const call = callFor(connection);
    if (!call) {
      send(connection.socket, { type: 'call', call: null });
      return;
    }
    const identity = participantIdentity(connection.userId);
    connection.call = { ...call, identity };
    let token;
    try {
      token = await mintRoomToken(media, {
        room: call.room,
        identity,
        name: connection.appearance.displayName ?? undefined,
        canPublish: true,
      });
    } catch (err) {
      app.log.error(
        { err, userId: connection.userId, spaceKey: connection.spaceKey },
        'could not mint a token for a space’s call',
      );
      if (connection.call?.identity === identity) {
        connection.call = undefined;
        if (connections.has(connection)) {
          send(connection.socket, { type: 'call', call: null });
        }
      }
      return;
    }
    // Walked on, or gone, while the token was minted: that call is stale.
    if (connection.call?.identity !== identity || !connections.has(connection))
      return;
    send(connection.socket, {
      type: 'call',
      call: { ...call, url: token.url, token: token.token },
    });
  }

  /**
   * Relays a line of chat to whoever can hear the speaker, and back to the
   * speaker. A space with no row yet is heard by distance, at the default
   * radius. Never stored, and never logged: what people say is theirs.
   */
  function say(connection: Connection, text: string, budget: SayBudget): void {
    if (!budget.admit(Date.now())) {
      send(connection.socket, {
        type: 'error',
        code: ServerErrorCode.NotAllowed,
        message: 'saying too much too fast',
      });
      return;
    }
    const speaker = players.get(connection);
    if (!speaker) return;
    const space = doors.get(connection.spaceKey);
    const hearing: Hearing =
      space && space.audioMode !== 'proximity'
        ? { kind: 'room' }
        : {
            kind: 'proximity',
            radius: space?.subscribeRadius ?? DEFAULT_SUBSCRIBE_RADIUS,
          };
    const others = connections.all().flatMap((other) => {
      if (other.cohortId !== connection.cohortId || other === connection) {
        return [];
      }
      const player = players.get(other);
      return player
        ? [{ connection: other, ...player, spaceKey: other.spaceKey }]
        : [];
    });
    const frame = encode({
      type: 'said',
      id: randomUUID(),
      userId: connection.userId,
      spaceKey: connection.spaceKey,
      text,
      at: new Date().toISOString(),
    });
    sendFrame(connection.socket, frame);
    for (const listener of inEarshot(
      { ...speaker, spaceKey: connection.spaceKey },
      others,
      hearing,
    )) {
      sendFrame(listener.connection.socket, frame);
    }
  }

  /**
   * How long a token that may speak in the broadcast room lasts. Only for
   * joining, as LiveKit keeps a connected participant's token fresh itself;
   * short, so an admin who stops being one cannot rejoin with it and speak.
   */
  const SPEAKING_TOKEN_TTL_SECONDS = 60;
  /** Sockets whose broadcast token could not be minted: the heartbeat tries again. */
  const broadcastMissing = new WeakSet<Connection>();

  function leaveBroadcast(connection: Connection): void {
    const broadcast = connection.broadcast;
    if (!broadcast) return;
    connection.broadcast = undefined;
    removeFromRoom(broadcast.room, broadcast.identity);
  }

  /**
   * Hands the socket its cohort's broadcast room, beside the space's call:
   * admins may speak there, microphone only; everybody else listens.
   */
  async function joinBroadcast(connection: Connection): Promise<void> {
    if (!media) return;
    broadcastMissing.delete(connection);
    leaveBroadcast(connection);
    let room: string;
    try {
      room = broadcastRoomName(connection.cohortId);
    } catch {
      send(connection.socket, { type: 'broadcast', call: null });
      return;
    }
    const canSpeak = hasAdminPowers(connection.systemRole);
    const identity = participantIdentity(connection.userId);
    connection.broadcast = { room, identity, canSpeak };
    let token;
    try {
      token = await mintRoomToken(media, {
        room,
        identity,
        name: connection.appearance.displayName ?? undefined,
        canPublish: canSpeak,
        audioOnly: true,
        ttlSeconds: canSpeak ? SPEAKING_TOKEN_TTL_SECONDS : undefined,
      });
    } catch (err) {
      app.log.error(
        { err, userId: connection.userId },
        'could not mint a token for the broadcast room',
      );
      if (connection.broadcast?.identity === identity) {
        connection.broadcast = undefined;
        if (connections.has(connection)) {
          broadcastMissing.add(connection);
          send(connection.socket, { type: 'broadcast', call: null });
        }
      }
      return;
    }
    if (
      connection.broadcast?.identity !== identity ||
      !connections.has(connection)
    )
      return;
    send(connection.socket, {
      type: 'broadcast',
      call: { url: token.url, room, token: token.token, canSpeak },
    });
  }

  /**
   * Admins may act on anybody in their cohort's campus; a professor or
   * mentor only on somebody in the designated space they stand in, whose
   * list names them. Never on an admin, nor on themselves.
   */
  function mayModerate(
    actor: Connection,
    target: Connection,
    now: Date,
  ): boolean {
    if (actor.userId === target.userId || hasAdminPowers(target.systemRole)) {
      return false;
    }
    if (hasAdminPowers(actor.systemRole)) return true;
    const space = doors.get(actor.spaceKey);
    return (
      STAFF_ROLES.has(actor.membership?.role ?? '') &&
      actor.spaceKey === target.spaceKey &&
      space?.access === SPACE_ACCESS.Designated &&
      mayEnter(personOf(actor), { ...space, locked: false }, now)
    );
  }

  function staffRefusal(connection: Connection, message: string): void {
    send(connection.socket, {
      type: 'error',
      code: ServerErrorCode.NotAllowed,
      message,
    });
  }

  async function muteSomebody(
    actor: Connection,
    userId: string,
  ): Promise<void> {
    const target = connections.holderOf({ userId, cohortId: actor.cohortId });
    if (!target) {
      staffRefusal(actor, 'they are not here');
      return;
    }
    if (!mayModerate(actor, target, new Date())) {
      staffRefusal(actor, 'you may not mute them');
      return;
    }
    const call = target.call;
    if (!muteMicrophone || !call) {
      staffRefusal(actor, 'they are in no call');
      return;
    }
    let result: MuteResult;
    try {
      result = await muteMicrophone(call.room, call.identity);
    } catch (err) {
      app.log.warn({ err, userId }, 'could not mute somebody');
      staffRefusal(actor, 'could not mute them, try again');
      return;
    }
    if (result === 'not_in_room') {
      staffRefusal(actor, 'they are not in the call');
      return;
    }
    if (result === 'not_on') {
      staffRefusal(actor, 'their microphone is not on');
      return;
    }
    announceStaffAction('muted', actor, target, target.spaceKey, null, null);
  }

  function removeSomebody(actor: Connection, userId: string): void {
    const now = Date.now();
    const target = connections.holderOf({ userId, cohortId: actor.cohortId });
    if (!target) {
      staffRefusal(actor, 'they are not here');
      return;
    }
    if (!mayModerate(actor, target, new Date(now))) {
      staffRefusal(actor, 'you may not remove them');
      return;
    }
    const spaceKey = target.spaceKey;
    if (spaceKey === DEFAULT_SPACE_KEY) {
      staffRefusal(actor, 'they are in no space');
      return;
    }
    // Removed, they may ask to enter: only from a space that takes requests.
    if (!takesRequests(doors.get(spaceKey), true)) {
      staffRefusal(actor, 'they cannot be removed from this space');
      return;
    }
    const standing = players.get(target);
    const outside =
      standing &&
      nearestOutside(map.grid, map.spaces, standing, spaceKey, (into) =>
        mayStepInto(target, into, new Date(now)),
      );
    const player = outside && players.place(target, outside);
    if (!player) {
      staffRefusal(actor, 'nowhere outside to move them');
      return;
    }
    const until = removals.remove(target, spaceKey, now);
    requests.dropPass(target);
    noteMoved(target);
    arrivedAt(target, player);
    // An open request turns into "may walk in" once the 90 seconds are up;
    // a millisecond after, as a timer can fire a little early.
    setTimeout(
      () => reviewRequests(target.cohortId, spaceKey),
      until - Date.now() + 1,
    ).unref();
    announceStaffAction(
      'removed',
      actor,
      target,
      spaceKey,
      new Date(until).toISOString(),
      player,
    );
  }

  /** Turned or moved: the next tick sends it, and the next save keeps it. */
  function noteMoved(connection: Connection): void {
    // The two fields copied out, not the connection: these maps outlive the
    // socket, and holding it would keep it in memory.
    const seat: Seat = {
      userId: connection.userId,
      cohortId: connection.cohortId,
    };
    const key = seatKey(seat);
    pendingMoves.set(key, seat);
    unsaved.set(key, seat);
  }

  /** On a new tile: maybe in another space, maybe away from a door. */
  function arrivedAt(connection: Connection, tile: Tile): void {
    recordSpaceCrossing(connection, tile);
    leaveTheDoor(connection, tile);
  }

  /** To the staff member and to the person it was done to. */
  function announceStaffAction(
    action: 'muted' | 'removed',
    actor: Connection,
    target: Connection,
    spaceKey: string,
    until: string | null,
    player: Player | null,
  ): void {
    recordStaffAction(action, actor, target, spaceKey);
    const frame = encode({
      type: 'staffAction',
      action,
      userId: target.userId,
      by: actor.userId,
      spaceKey,
      until,
      player,
    });
    for (const connection of new Set([actor, target])) {
      if (connections.has(connection)) sendFrame(connection.socket, frame);
    }
  }

  /**
   * Belongs in the audit log, which campus-api writes. world cannot ask
   * campus-api to yet, so until it can, the action is only logged.
   */
  function recordStaffAction(
    action: 'muted' | 'removed',
    actor: Connection,
    target: Connection,
    spaceKey: string,
  ): void {
    app.log.info(
      {
        action,
        actorId: actor.userId,
        targetId: target.userId,
        cohortId: target.cohortId,
        spaceKey,
      },
      'staff action',
    );
  }

  /** After the spaces are read: a new call for anybody whose space's call is not the one they hold. */
  function refreshCalls(): void {
    if (!media || stopping) return;
    for (const connection of connections.all()) {
      if (!sameCall(callFor(connection), connection.call)) {
        void joinCall(connection);
      }
    }
  }

  /**
   * Who each person in a proximity space can hear: the others in the same
   * space within its subscribe radius, kept until they are past the radius
   * times its hysteresis, so standing on the line does not flicker. Leaving
   * a proximity space empties the list, and says so.
   */
  function updateNearby(inCohort: readonly Connection[]): void {
    const here = inCohort.flatMap((connection) => {
      const player = players.get(connection);
      return player ? [{ connection, player }] : [];
    });
    for (const { connection, player } of here) {
      const space = doors.get(connection.spaceKey);
      let next = new Set<string>();
      if (space?.audioMode === 'proximity') {
        for (const other of here) {
          if (
            other.connection === connection ||
            other.connection.spaceKey !== connection.spaceKey
          )
            continue;
          const distance = Math.hypot(
            other.player.x - player.x,
            other.player.y - player.y,
          );
          const reach = connection.nearby.has(other.connection.userId)
            ? space.subscribeRadius * space.hysteresisFactor
            : space.subscribeRadius;
          if (distance <= reach) next.add(other.connection.userId);
        }
      } else if (connection.nearby.size === 0) {
        continue;
      } else {
        next = new Set();
      }
      if (
        next.size !== connection.nearby.size ||
        [...next].some((userId) => !connection.nearby.has(userId))
      ) {
        connection.nearby = next;
        send(connection.socket, { type: 'nearby', userIds: [...next].sort() });
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
        if (connections.holderOf({ userId, cohortId })) {
          unsaved.set(seatKey({ userId, cohortId }), { userId, cohortId });
        }
      }
    });
  }

  /** Forgets one cohort's kept position, for access taken away. */
  function forgetSaved(seat: Seat): void {
    const { userId, cohortId } = seat;
    unsaved.delete(seatKey(seat));
    positions.forget(seat).catch((err: unknown) => {
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

  /** A write found a newer connection holding this one's place. */
  function lostPlace(connection: Connection): void {
    displacedElsewhere({
      userId: connection.userId,
      connectionId: connection.id,
    });
  }

  /**
   * After a move to `tile`: if it is in another space, tells the cohort and
   * records the new one in presence now, not at the next renewal. Skipped
   * once shutdown has begun, as the write would undo shutdown's removal. A failed write is put right
   * by the next renewal, which carries the space too.
   */
  function recordSpaceCrossing(connection: Connection, tile: Tile): void {
    const spaceKey = spaceAt(map.spaces, tile);
    if (spaceKey === connection.spaceKey) return;
    const left = connection.spaceKey;
    connection.spaceKey = spaceKey;
    if (stopping) return;
    broadcast(connection.cohortId, {
      type: 'spaceChanged',
      userId: connection.userId,
      spaceKey,
    });
    unlockIfEmpty(connection.cohortId, left);
    reviewRequests(connection.cohortId, left);
    reviewRequests(connection.cohortId, spaceKey);
    void joinCall(connection);
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

  const awayAfterMs = env.WORLD_AWAY_AFTER_SECONDS * 1000;

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
    presence.setStatus(presenceOf(connection)).catch((err: unknown) => {
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
    // A redeploy closes every socket, but LiveKit keeps running: calls are
    // left to the clients, which reconnect and are handed new ones.
    if (!stopping) {
      leaveCall(connection);
      leaveBroadcast(connection);
    }
    nearbyStale.add(connection.cohortId);
    // A connection displaced here no longer holds the account's presence;
    // after shutdown began, everybody has been removed already.
    if (connections.has(connection) && !stopping) {
      leavePresence([connection]);
    }
    // A replaced socket's request and yes were ended at the swap, and the
    // seat is the new socket's now: a late close must not touch them.
    const held = connections.has(connection);
    connections.remove(connection);
    if (!stopping) {
      unlockIfEmpty(connection.cohortId, connection.spaceKey);
      if (held) {
        if (requests.openFor(connection)?.asker === connection) {
          endRequest(connection, 'withdrawn');
        }
        requests.dropPass(connection);
      }
      reviewRequests(connection.cohortId, connection.spaceKey);
    }
    // Replaced in the same cohort: the avatar stays, and the new socket
    // stands for it. Their places in other cohorts are none of this.
    if (connections.holderOf(connection)) {
      return;
    }
    const seat = seatKey(connection);
    const standing = players.get(connection);
    if (players.leave(connection, Date.now(), remember)) {
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
      forgetSaved(connection);
    } else if (standing && !stopping) {
      unsaved.delete(seat);
      persist([positionOf(standing, connection.cohortId)]);
    }
  }

  /**
   * For what happens rarely enough to send at once, unlike moves. Only
   * to the cohort it happened in: each cohort is its own campus, and nobody
   * in one sees or hears of anybody in another, though they share this
   * process and the one map it loaded.
   */
  function broadcast(
    cohortId: string,
    message: ServerMessage,
    except?: Connection,
  ): void {
    const frame = encode(message);
    for (const connection of connections.all()) {
      if (connection.cohortId === cohortId && connection !== except) {
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
      const connection = connections.holderOf({
        userId: player.userId,
        cohortId,
      });
      return connection ? [avatarOf(player, connection)] : [];
    });
  }

  /**
   * Checked once per heartbeat rather than per frame: a ban, or the end of a
   * guest's visit, should take effect in seconds, and asking the database on
   * every message would put a query in the path of every movement. One query
   * per account, however many cohorts it has sockets in, plus one question
   * for the cohort membership behind every socket that is not an admin's —
   * one query for all of them together, as the session check beside it asks
   * for every login at once.
   */
  async function dropUnwelcome(): Promise<void> {
    const now = new Date();
    const byAccount = new Map<string, Connection[]>();
    for (const connection of connections.all()) {
      const open = byAccount.get(connection.userId);
      if (open) open.push(connection);
      else byAccount.set(connection.userId, [connection]);
    }

    // Every account is read before any membership is judged, because who is
    // excepted from the membership question — an admin — is on the account's
    // row. An account the database would not answer for is skipped alone,
    // and its sockets left to the next sweep.
    const known = new Map<string, Account | null>();
    const unasked = new Set<string>();
    for (const userId of byAccount.keys()) {
      try {
        known.set(userId, await accounts.find(userId));
      } catch (err) {
        // A database that is not answering must not throw everybody off the
        // campus; the next sweep tries again.
        app.log.error({ err, userId }, 'could not re-check account');
        unasked.add(userId);
      }
    }

    // The cohort every non-admin socket named, asked again — the upgrade
    // asks once, and nothing behind the socket keeps that answer true: a
    // guest's visit has an end date, and neither the access token the socket
    // opened with nor the login it follows runs out with it. So a membership
    // that ends while the socket is open has to reach that socket, within
    // one heartbeat — and asked once for every socket together, however
    // many are open, as the sessions beside it are.
    let members: Set<string> | undefined;
    const toAsk: Seat[] = [];
    for (const [userId, open] of byAccount) {
      const account = known.get(userId);
      if (!account || account.suspended || account.admin) continue;
      toAsk.push(...open);
    }
    let rows: Map<string, CohortMembershipFacts> | undefined;
    if (toAsk.length > 0) {
      try {
        members = await accounts.liveMemberships(toAsk, now);
      } catch (err) {
        // As with accounts: a database that is not answering must not throw
        // everybody off the campus. Membership stands as the last answer
        // left it, and the next sweep asks again.
        app.log.error({ err }, 'could not re-check membership');
      }
      // What the doors read: a track moved or a role changed reaches them
      // here, a heartbeat late at worst. Kept as they were when unread.
      try {
        rows = await accounts.memberships(toAsk);
      } catch (err) {
        app.log.error({ err }, 'could not re-read memberships for the doors');
      }
    }

    for (const [userId, open] of byAccount) {
      if (unasked.has(userId)) continue;
      const account = known.get(userId) ?? null;
      if (account && !account.suspended) {
        for (const connection of open) {
          dropIfRevoked(connection, account.sessionEpoch);
          // The account was read anyway. A change whose notification this
          // process missed, while it was reconnecting to the database, is
          // caught here, a heartbeat late at worst.
          showAppearance(connection, account);
          connection.systemRole = account.systemRole;
          // Made or unmade an admin: a new token, to speak or only listen.
          // Or the last one could not be minted: try again.
          if (
            broadcastMissing.has(connection) ||
            (connection.broadcast &&
              connection.broadcast.canSpeak !== account.admin)
          ) {
            void joinBroadcast(connection);
          }
          if (!account.admin && rows !== undefined) {
            connection.membership = rows.get(seatKey(connection)) ?? null;
          }
          // The cohort is asked again for everybody but an admin, who is
          // admitted on their role alone — from the row, as at the upgrade,
          // so a demotion lands on the socket already open too. The answer
          // came from the one query above; when the database gave none,
          // membership stands and the next sweep tries again.
          if (!account.admin && members !== undefined) {
            dropIfNotMember(connection, members.has(seatKey(connection)));
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
    reviewRequests();
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
   * Applies the sweep's membership answer to one socket: a seat among the
   * live ones stays. Admins are excepted by the caller, as they are at the
   * upgrade.
   *
   * And only one that still holds the account's place in its cohort, for the
   * same reason as dropIfRevoked: the answer was asked for every socket at
   * once and crossed an await, and in that time a newer socket may have
   * displaced this one — which has then been told `replaced` and closed
   * already, with nothing left to drop.
   */
  function dropIfNotMember(connection: Connection, live: boolean): void {
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
  const sweepUnwelcome = oneAtATime(
    () => traced('world.sweep.accounts', dropUnwelcome),
    sweepFailed,
  );
  const sweepSessions = oneAtATime(
    () => traced('world.sweep.sessions', dropEndedSessions),
    sweepFailed,
  );

  const heartbeat = setInterval(() => {
    sweepUnwelcome();
    sweepSessions();
    void reloadDoors();
    if (!stopping) retryRemovals();
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
        metrics.closedByServer('heartbeat_missed');
        connection.socket.terminate();
        continue;
      }
      if (connection.availability.checkIdle(now, awayAfterMs)) {
        statusChanged(connection);
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
        forgetSaved({ userId, cohortId });
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
    await doorsReady;

    if (closed || ws.readyState !== ws.OPEN) {
      attempt.outcome = 'abandoned';
      metrics.abandoned();
      annotate({ 'world.outcome': 'abandoned' });
      return;
    }

    if (!decision.ok) {
      attempt.outcome = 'refused';
      refuse(ws, decision.refusal);
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
      doorsRead &&
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
      // Before the new socket can ask: the old one's request ends with it.
      endRequest(displaced, 'withdrawn');
      requests.dropPass(displaced);
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
    attempt.outcome = 'opened';
    metrics.opened();
    annotate({ 'world.outcome': 'opened' });

    ws.on('pong', () => {
      connection.alive = true;
    });

    const budget = new FrameBudget(
      env.WORLD_MAX_MESSAGES_PER_SECOND,
      Date.now(),
    );
    const sayBudget = new SayBudget(Date.now());

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
      metrics.received(result.ok ? result.message.type : 'invalid');
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
        case 'active':
          noteActivity(connection);
          return;
        case 'setStatus':
          if (
            connection.availability.choose(result.message.status, Date.now())
          ) {
            statusChanged(connection);
          }
          return;
        case 'setLock':
          noteActivity(connection);
          setLock(connection, result.message.locked);
          return;
        case 'requestEntry':
          noteActivity(connection);
          requestEntry(connection, result.message.spaceKey);
          return;
        case 'withdrawEntryRequest':
          noteActivity(connection);
          withdrawEntryRequest(connection, result.message.requestId);
          return;
        case 'answerEntryRequest':
          noteActivity(connection);
          answerEntryRequest(
            connection,
            result.message.requestId,
            result.message.admit,
          );
          return;
        case 'say':
          noteActivity(connection);
          say(connection, result.message.text, sayBudget);
          return;
        case 'mute':
          noteActivity(connection);
          void muteSomebody(connection, result.message.userId);
          return;
        case 'removeFromSpace':
          noteActivity(connection);
          removeSomebody(connection, result.message.userId);
          return;
        case 'move': {
          noteActivity(connection);
          const { direction, seq } = result.message;
          const now = Date.now();
          // Asked only on a step into another space: somebody already inside
          // stays until they leave, whatever has changed since they came in.
          const moved = players.move(connection, direction, now, (target) => {
            const into = spaceAt(map.spaces, target);
            return (
              into === connection.spaceKey ||
              mayStepInto(connection, into, new Date(now)) ||
              hasPass(connection, into)
            );
          });
          metrics.moved(moved.outcome);
          send(ws, {
            type: 'moveResult',
            seq,
            outcome: moved.outcome,
            player: moved.player,
          });
          if (moved.outcome === 'moved') arrivedAt(connection, moved.player);
          if (moved.changed) noteMoved(connection);
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
      players: avatarsIn(connection.cohortId),
      lockableSpaces: [...lockable],
      lockedSpaces: locks.in(connection.cohortId),
    });
    void joinCall(connection);
    void joinBroadcast(connection);
    reviewRequests(connection.cohortId, connection.spaceKey);

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

  function send(ws: WebSocket, message: ServerMessage): void {
    sendFrame(ws, encode(message));
  }

  function sendFrame(ws: WebSocket, frame: string): void {
    const bufferedBytes = ws.bufferedAmount;
    const delivery = deliver(ws, frame, env.WORLD_MAX_BUFFERED_BYTES);
    if (delivery === 'sent') {
      metrics.sentFrame();
    } else if (delivery === 'lagging') {
      metrics.closedByServer('not_reading');
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
    spacesChanged: reloadDoors,
    dispose: metrics.dispose,
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
            const player = players.get(connection);
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

function personOf(connection: Connection): PersonFacts {
  return {
    userId: connection.userId,
    systemRole: connection.systemRole,
    cohortId: connection.cohortId,
    membership: connection.membership,
  };
}

/** The seat an accepted upgrade asks for. */
function seatOf(decision: Extract<UpgradeDecision, { ok: true }>): Seat {
  return { userId: decision.claims.userId, cohortId: decision.cohortId };
}

function avatarOf(player: Player, connection: Connection): Avatar {
  return {
    ...player,
    ...connection.appearance,
    status: connection.availability.shown,
    spaceKey: connection.spaceKey,
  };
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
