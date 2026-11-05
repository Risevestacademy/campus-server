import { DEFAULT_SPACE_KEY } from '@campus/session';
import { SPACE_ACCESS, mayEnter } from '@campus/space-access';

import type { Tile } from '../../movement/grid.js';
import type { Seat } from '../../seat.js';
import {
  EntryRequests,
  besideSpace,
  obstacle,
  takesRequests,
  type EntryRequest,
  type Obstacle,
  type RequestFacts,
} from '../../spaces/requests.js';
import { personOf, type Connection } from '../connections.js';
import type { WorldContext } from '../context.js';
import {
  ServerErrorCode,
  encode,
  type EntryRequestOutcome,
} from '../protocol.js';
import type { Doors } from './doors.js';
import type { Locks } from './locks.js';

type EntryRequestsContext = Pick<
  WorldContext,
  'map' | 'connections' | 'players' | 'send' | 'sendFrame' | 'isStopping'
>;

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

export interface EntryRequestDeps {
  doors: Pick<Doors, 'get'>;
  locks: Pick<Locks, 'isLocked'>;
  isRemoved(connection: Connection, spaceKey: string, now: number): boolean;
  mayStepInto(connection: Connection, spaceKey: string, now: Date): boolean;
}

export type EntryRequestsFeature = ReturnType<typeof createEntryRequests>;

export function createEntryRequests(
  ctx: EntryRequestsContext,
  { doors, locks, isRemoved, mayStepInto }: EntryRequestDeps,
) {
  const { map, connections, players, send, sendFrame, isStopping } = ctx;
  const requests = new EntryRequests<Connection>();

  /** Somebody staff removed from a normal space finds it locked to them alone, so they may ask. */
  function spaceTakesRequests(
    connection: Connection,
    spaceKey: string,
  ): boolean {
    return takesRequests(
      doors.get(spaceKey),
      locks.isLocked(connection.cohortId, spaceKey) ||
        isRemoved(connection, spaceKey, Date.now()),
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

  function request(connection: Connection, spaceKey: string): void {
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
    review(connection.cohortId, spaceKey);
  }

  /** By the request's id, not the asker's: a late answer never reaches a newer request. */
  function answer(
    connection: Connection,
    requestId: string,
    admit: boolean,
  ): void {
    const now = new Date();
    const found = requests.find(requestId);
    if (
      !found ||
      found.cohortId !== connection.cohortId ||
      !mayAnswer(connection, found.spaceKey, now)
    ) {
      send(connection.socket, {
        type: 'error',
        code: ServerErrorCode.NotAllowed,
        message: 'no request here for you to answer',
      });
      return;
    }
    if (admit) requests.admit(found);
    else requests.decline(found, now.getTime());
    announceEnded(found, admit ? 'admitted' : 'declined', connection.userId);
  }

  function withdraw(connection: Connection, requestId: string): void {
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
    const closed = requests.close(seat);
    if (closed) announceEnded(closed, outcome, null);
  }

  /** The asker is told even once replaced: its socket is still open, and it asked. */
  function announceEnded(
    ended: EntryRequest<Connection>,
    outcome: EntryRequestOutcome,
    answeredBy: string | null,
  ): void {
    const frame = encode({
      type: 'entryRequestEnded',
      requestId: ended.id,
      userId: ended.userId,
      spaceKey: ended.spaceKey,
      outcome,
      answeredBy,
    });
    if (ended.asker.socket.readyState === ended.asker.socket.OPEN) {
      sendFrame(ended.asker.socket, frame);
    }
    for (const connection of ended.told) {
      if (connection !== ended.asker && connections.has(connection)) {
        sendFrame(connection.socket, frame);
      }
    }
  }

  /**
   * After anything that changes who may enter or answer: ends the requests
   * no longer needed or answerable, sends the rest to anybody inside who may
   * answer and has not been sent them, and drops the yeses no longer good.
   */
  function review(cohortId?: string, spaceKey?: string): void {
    if (isStopping()) return;
    const now = new Date();
    for (const open of requests.all(cohortId, spaceKey)) {
      if (connections.holderOf(open) !== open.asker) {
        endRequest(open, 'withdrawn');
        continue;
      }
      const found = obstacle(requestFacts(open.asker, open.spaceKey, now));
      if (found) {
        endRequest(open, ENDINGS[found]);
        continue;
      }
      const frame = encode({
        type: 'entryRequested',
        requestId: open.id,
        userId: open.userId,
        spaceKey: open.spaceKey,
      });
      for (const answerer of answersIn(open, now)) {
        open.told.add(answerer);
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
  function answersIn(open: EntryRequest<Connection>, now: Date): Connection[] {
    return answerersIn(open.cohortId, open.spaceKey, now).filter(
      (answerer) => !open.told.has(answerer),
    );
  }

  /** After a step: leaving the tiles beside a space ends a request to it, and lets a yes lapse. */
  function leaveTheDoor(connection: Connection, tile: Tile): void {
    const open = requests.openFor(connection);
    if (open && !besideSpace(map.grid, map.spaces, tile, open.spaceKey)) {
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

  /** A socket that held its seat closed: its request and its yes end with it. */
  function left(connection: Connection): void {
    if (requests.openFor(connection)?.asker === connection) {
      endRequest(connection, 'withdrawn');
    }
    requests.dropPass(connection);
  }

  /** Before the new socket can ask: the old one's request ends with it. */
  function replaced(displaced: Connection): void {
    endRequest(displaced, 'withdrawn');
    requests.dropPass(displaced);
  }

  return {
    request,
    answer,
    withdraw,
    review,
    leaveTheDoor,
    hasPass,
    mayAsk: (connection: Connection, spaceKey: string, now: Date): boolean =>
      whyNotAsk(connection, spaceKey, now) === null,
    left,
    replaced,
    passFor: (seat: Seat) => requests.passFor(seat),
    dropPass: (seat: Seat) => requests.dropPass(seat),
  };
}
