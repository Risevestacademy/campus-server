import type { Analytics, EventName, EventProperties } from '@campus/analytics';
import { DEFAULT_SPACE_KEY, hasAdminPowers } from '@campus/contracts';

import type { Connection } from '../connections.js';
import type {
  CloseReason,
  EntryRequestOutcome,
  WalkEndReason,
} from '../protocol.js';
import type { Doors } from './doors.js';

/** A visit shorter than this is walking through, not a visit. */
export const VISIT_FLOOR_MS = 10_000;

/** One refusal per person per space in this long: a held key bumps the door every step. */
export const REFUSAL_EVERY_MS = 60_000;

export type ArrivedBy = EventProperties<'space.visited'>['arrived_by'];
export type Refusal = EventProperties<'space.refused'>['reason'];
export type RequestReason = EventProperties<'entry.request_ended'>['reason'];
type PresenceEnd = EventProperties<'presence.ended'>['reason'];

interface Visit {
  spaceKey: string;
  since: number;
  arrivedBy: ArrivedBy;
  lines: number;
}

const ACCESS_ENDED: ReadonlySet<CloseReason> = new Set([
  'account_suspended',
  'account_gone',
  'not_a_member',
  'no_cohort',
  'wrong_scope',
  'token_not_usable',
  'no_token',
  'origin_not_allowed',
]);

/** Why a socket's presence ended, from what closed it. */
export function presenceEndOf(
  reason: CloseReason | undefined,
  code: number,
): PresenceEnd {
  if (reason === undefined) return code === 1006 ? 'lost' : 'closed';
  if (reason === 'entered_elsewhere') return 'replaced';
  if (reason === 'server shutting down') return 'shutdown';
  if (
    reason === 'session_ended' ||
    reason === 'session_revoked' ||
    reason === 'session_expired'
  ) {
    return 'signed_out';
  }
  if (ACCESS_ENDED.has(reason)) return 'access_ended';
  return 'error';
}

const seconds = (ms: number): number => Math.max(0, Math.floor(ms / 1000));

/**
 * Product events from the campus. Everything here is about one person, so it
 * goes under their id only when they granted consent, and otherwise under the
 * socket's id, which links one visit's events to nobody. Never throws:
 * `track` drops what it cannot send.
 */
export function createWorldAnalytics(
  analytics: Analytics,
  doors: Pick<Doors, 'get'>,
) {
  const open = new Set<Connection>();
  const visits = new Map<Connection, Visit>();
  const refusedAt = new Map<Connection, Map<string, number>>();
  const requests = new Map<
    string,
    { askedAt: number; reason: RequestReason }
  >();

  function track<E extends EventName>(
    connection: Connection,
    event: E,
    properties: EventProperties<E>,
  ): void {
    analytics.track(event, connection.userId, properties, {
      cohortId: connection.cohortId,
      consented: connection.analyticsConsent,
      sessionId: connection.id,
    });
  }

  /** What the events say of a drawn space; nothing for the corridors or one not read. */
  function spaceOf(spaceKey: string) {
    if (spaceKey === DEFAULT_SPACE_KEY) return undefined;
    const space = doors.get(spaceKey);
    if (!space) return undefined;
    return {
      space,
      fields: {
        space_id: space.id,
        space_kind: (space.kind ??
          'unset') as EventProperties<'space.visited'>['space_kind'],
      },
    };
  }

  function endVisit(connection: Connection, now: number): void {
    const visit = visits.get(connection);
    if (!visit) return;
    visits.delete(connection);
    const found = spaceOf(visit.spaceKey);
    if (!found || now - visit.since < VISIT_FLOOR_MS) return;
    track(connection, 'space.visited', {
      ...found.fields,
      access: found.space.access as EventProperties<'space.visited'>['access'],
      audio_mode: found.space.audioMode,
      duration_s: seconds(now - visit.since),
      arrived_by: visit.arrivedBy,
      lines_said: visit.lines,
    });
  }

  /** Once per socket, however many ways its end is reported. */
  function ended(connection: Connection, reason: PresenceEnd): void {
    if (!open.delete(connection)) return;
    const now = Date.now();
    endVisit(connection, now);
    refusedAt.delete(connection);
    track(connection, 'presence.ended', {
      client: connection.client,
      mode: connection.mode,
      duration_s: seconds(now - connection.openedAt),
      reason,
    });
  }

  return {
    ended,

    endAll(reason: PresenceEnd): void {
      for (const connection of open) ended(connection, reason);
    },

    started(connection: Connection, reconnect: boolean): void {
      open.add(connection);
      track(connection, 'presence.started', {
        client: connection.client,
        reconnect,
        mode: connection.mode,
      });
    },

    /** Their avatar now stands in `connection.spaceKey`; whatever visit came before is over. */
    entered(connection: Connection, arrivedBy: ArrivedBy): void {
      const now = Date.now();
      endVisit(connection, now);
      if (!open.has(connection) || connection.spaceKey === DEFAULT_SPACE_KEY) {
        return;
      }
      visits.set(connection, {
        spaceKey: connection.spaceKey,
        since: now,
        arrivedBy,
        lines: 0,
      });
    },

    /** Their avatar left the campus but the socket stays, as a watcher. */
    leftSpace(connection: Connection): void {
      endVisit(connection, Date.now());
    },

    said(connection: Connection): void {
      const visit = visits.get(connection);
      if (visit) visit.lines += 1;
    },

    statusChosen(
      connection: Connection,
      status: EventProperties<'status.chosen'>['status'],
      timed: boolean,
    ): void {
      track(connection, 'status.chosen', { status, timed });
    },

    refused(
      connection: Connection,
      spaceKey: string,
      reason: Refusal,
      mayAsk: boolean,
    ): void {
      const found = spaceOf(spaceKey);
      if (!found) return;
      const now = Date.now();
      let last = refusedAt.get(connection);
      if (!last) {
        last = new Map();
        refusedAt.set(connection, last);
      }
      const at = last.get(spaceKey);
      if (at !== undefined && now - at < REFUSAL_EVERY_MS) return;
      last.set(spaceKey, now);
      track(connection, 'space.refused', {
        ...found.fields,
        reason,
        may_ask: mayAsk,
      });
    },

    lockChanged(
      connection: Connection,
      spaceKey: string,
      locked: boolean,
      occupants: number,
    ): void {
      const found = spaceOf(spaceKey);
      if (!found) return;
      track(connection, 'space.lock_changed', {
        ...found.fields,
        locked,
        occupants,
      });
    },

    requestOpened(requestId: string, reason: RequestReason): void {
      requests.set(requestId, { askedAt: Date.now(), reason });
    },

    requestEnded(
      request: { id: string; spaceKey: string; asker: Connection },
      outcome: EntryRequestOutcome,
    ): void {
      const opened = requests.get(request.id);
      requests.delete(request.id);
      const found = spaceOf(request.spaceKey);
      if (!opened || !found) return;
      track(request.asker, 'entry.request_ended', {
        ...found.fields,
        reason: opened.reason,
        outcome,
        wait_s: seconds(Date.now() - opened.askedAt),
      });
    },

    walkEnded(
      connection: Connection,
      target: EventProperties<'walk.ended'>['target'],
      reason: WalkEndReason,
      steps: number,
    ): void {
      track(connection, 'walk.ended', { target, reason, steps });
    },

    /** Staff doing their job: under their id, consent or not, and never naming whom. */
    staffActed(
      actor: Connection,
      action: EventProperties<'staff.acted'>['action'],
      spaceKey: string,
    ): void {
      const found = spaceOf(spaceKey);
      const role = hasAdminPowers(actor.systemRole)
        ? 'admin'
        : actor.membership?.role;
      if (
        !found ||
        (role !== 'admin' && role !== 'professor' && role !== 'mentor')
      ) {
        return;
      }
      track(actor, 'staff.acted', {
        action,
        space_kind: found.fields.space_kind,
        actor_role: role,
      });
    },
  };
}

export type WorldAnalytics = ReturnType<typeof createWorldAnalytics>;
