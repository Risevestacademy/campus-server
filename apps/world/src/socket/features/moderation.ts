import { microphoneMuter, type MuteResult } from '@campus/media';
import { DEFAULT_SPACE_KEY, hasAdminPowers } from '@campus/session';
import { COHORT_ROLES, SPACE_ACCESS, mayEnter } from '@campus/space-access';

import type { mediaCredentials } from '../../infra/env.js';
import type { Player } from '../../movement/players.js';
import { SpaceRemovals, nearestOutside } from '../../spaces/removals.js';
import { takesRequests } from '../../spaces/requests.js';
import { personOf, type Connection } from '../connections.js';
import type { WorldContext } from '../context.js';
import { ServerErrorCode, encode } from '../protocol.js';
import type { Doors } from './doors.js';
import type { EntryRequestsFeature } from './entry-requests.js';

type ModerationContext = Pick<
  WorldContext,
  'app' | 'map' | 'connections' | 'players' | 'send' | 'sendFrame'
>;

/** The cohort roles that moderate a designated space whose list names them. */
const STAFF_ROLES = new Set<string>([
  COHORT_ROLES.Professor,
  COHORT_ROLES.Mentor,
]);

export interface ModerationDeps {
  doors: Pick<Doors, 'get'>;
  requests: Pick<EntryRequestsFeature, 'dropPass' | 'review'>;
  media: ReturnType<typeof mediaCredentials>;
  mayStepInto(connection: Connection, spaceKey: string, now: Date): boolean;
  /** Put outside by staff: what a step onto that tile would do, and the end of any walk. */
  movedOut(target: Connection, player: Player): void;
}

export function createModeration(
  ctx: ModerationContext,
  { doors, requests, media, mayStepInto, movedOut }: ModerationDeps,
) {
  const { app, map, connections, players, send, sendFrame } = ctx;
  const muteMicrophone = media ? microphoneMuter(media) : undefined;
  const removals = new SpaceRemovals();

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

  async function mute(actor: Connection, userId: string): Promise<void> {
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

  function remove(actor: Connection, userId: string): void {
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
    movedOut(target, player);
    // An open request turns into "may walk in" once the 90 seconds are up;
    // a millisecond after, as a timer can fire a little early.
    setTimeout(
      () => requests.review(target.cohortId, spaceKey),
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

  return {
    mute,
    remove,
    isRemoved: (connection: Connection, spaceKey: string, now: number) =>
      removals.isRemoved(connection, spaceKey, now),
  };
}
