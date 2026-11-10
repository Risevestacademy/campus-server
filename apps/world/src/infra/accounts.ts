import {
  DESKS_CHANGED_CHANNEL,
  PROFILE_CHANGED_CHANNEL,
  hasAdminPowers,
  spriteKeyOrNone,
} from '@campus/session';
import {
  SPACES_CHANGED_CHANNEL,
  type CohortMembershipFacts,
  type SpaceFacts,
  type SpaceGrantFacts,
} from '@campus/space-access';
import { installPostgresTracing } from '@campus/telemetry/sql';
import postgres from 'postgres';

import { SeatMap, seatKey, type Seat } from '../seat.js';
import type { Env } from './env.js';

/**
 * What the socket layer needs from the database: who is behind a token, the
 * spaces they move through, and the one row world writes, the asker's
 * notification. An interface so the gateway can be tested without a database
 * and so the lookup can move behind Redis later without touching callers.
 */
export interface AccountLookup {
  /** Null when no such account exists — a token outliving its user. */
  find(userId: string): Promise<Account | null>;
  /**
   * Which of these sessions (refresh-token families) are still live: not
   * revoked, not expired, and refreshed at or after `refreshedSince`. One
   * query for every open socket, however many there are.
   */
  liveSessions(
    sessionIds: readonly string[],
    refreshedSince: Date,
    now: Date,
  ): Promise<Set<string>>;
  /**
   * The key of the entry map an admin has published, or null when none has.
   * World serves one map: this is the database saying which version of the
   * campus is live. The geometry itself still comes from Sanity; only the
   * key and the decision to serve it are kept here.
   */
  publishedEntryMapKey(): Promise<string | null>;
  liveMembership(seat: Seat, now: Date): Promise<boolean>;
  /**
   * Which of these seats still hold a live membership: one query for every
   * open socket, however many there are, as `liveSessions` does for logins.
   * Answered as `seatKey` of the live ones.
   */
  liveMemberships(seats: readonly Seat[], now: Date): Promise<Set<string>>;
  /**
   * Each seat's `cohort_members` row as it stands, ended or not: what a
   * space's door reads their role and track from, and decides for itself
   * whether it is live. One query for every seat, answered by `seatKey`; a
   * seat with no row is left out.
   */
  memberships(
    seats: readonly Seat[],
  ): Promise<Map<string, CohortMembershipFacts>>;
  /**
   * Every space on a map, by key, with the entries on its list that have
   * not ended by `now`: what the door needs to decide who may step in. Two
   * queries however many spaces there are. `locked` is always false here:
   * world holds locks, not the database.
   */
  spacesOn(mapKey: string, now: Date): Promise<Map<string, WorldSpace>>;
  /**
   * The passes of people who entered through a room link to a space on this
   * map whose window has not ended by `now`. The door decides whether each
   * window is open yet.
   */
  roomLinkPassesOn(mapKey: string, now: Date): Promise<RoomLinkPass[]>;
  /**
   * Calls `listener` with a published map's key, or with '' when something a
   * space's door reads changed. `reconnected` is called again whenever
   * listening (re)starts, since a change made while it was not listening
   * reached nobody; left out, the listener gets '' instead. Resolves once
   * listening; rejects if it could not start.
   */
  onSpacesChanged(
    listener: (payload: string) => void,
    reconnected?: () => void,
  ): Promise<void>;
  /**
   * Calls `listener` with an account id whenever campus-api says that
   * account's sprite or display name changed. Resolves once listening;
   * rejects if it could not start.
   */
  onProfileChanged(listener: (userId: string) => void): Promise<void>;
  /**
   * Calls `listener` with a cohort id, or null for every cohort, whenever
   * campus-api says who holds a desk there may have changed. Resolves once
   * listening; rejects if it could not start.
   */
  onDesksChanged(listener: (cohortId: string | null) => void): Promise<void>;
  /**
   * world's one write: the asker's notification, answered as written for
   * the push. A repeat writes nothing and answers undefined.
   */
  notifyEntryRequestAnswered(
    answer: EntryRequestAnswer,
  ): Promise<WrittenNotification | undefined>;
  close(): Promise<void>;
}

export interface EntryRequestAnswer {
  requestId: string;
  askerId: string;
  admitted: boolean;
  cohortId: string;
  spaceKey: string;
}

export interface WrittenNotification {
  id: string;
  kind: string;
  referenceType: string;
  referenceId: string;
  context: { cohortId: string; spaceKey: string } | null;
  createdAt: Date;
}

/**
 * What everybody else draws for them, as their profile has it when they
 * enter. Read once per socket, so a change shows the next time they enter.
 */
export interface Appearance {
  displayName: string | null;
  /**
   * Null when none is picked, and for a stored key no longer on the list:
   * clients draw their default for both.
   */
  spriteKey: string | null;
}

export interface Account extends Appearance {
  id: string;
  suspended: boolean;
  /**
   * USERS.session_epoch: how many times this account's sessions have been
   * ended on purpose. A token signed with any other value is one of those
   * ended sessions.
   */
  sessionEpoch: number;
  /** Admins bypass cohort gating, as they do at campus-api's sign-in gate. */
  admin: boolean;
  /** `users.system_role` as text, which a space's list may name. */
  systemRole: string;
}

/**
 * Exported so a test can run the very same statement against a real
 * PostgreSQL engine. The columns belong to campus-api's migration, and a
 * rename there would otherwise only surface as every socket refusing a
 * perfectly good session.
 */
export const ACCOUNT_QUERY =
  'select id, status, system_role, session_epoch, display_name, sprite_key from users where id = $1 limit 1';

/**
 * A login is live while its refresh family holds a token that is neither
 * revoked nor expired and was minted recently. Rotation mints a new row on
 * every refresh, and every refresh re-checks suspension and access first, so
 * "minted recently" is campus-api vouching for the session again. Signing out
 * revokes the family outright.
 *
 * `revoked_at is null and expires_at > $3` is @campus/session's
 * `isRefreshTokenLive`, written in SQL; the two must agree, or world holds a
 * socket on a token campus-api will no longer refresh. `created_at >= $2` is
 * world's own rule on top.
 *
 * $1 uuid[] of families, $2 refreshed-since, $3 now. Same reason to export it
 * as ACCOUNT_QUERY: refresh_tokens belongs to campus-api.
 */
export const LIVE_SESSIONS_QUERY = `select distinct family_id from refresh_tokens
  where family_id = any($1::uuid[])
    and revoked_at is null
    and expires_at > $3
    and created_at >= $2`;

/**
 * The one question about a membership. Must stay the same as campus-api's
 * `isLiveMembership`, or the two disagree about who belongs. Written once so
 * the two statements below — a pair at a time, or many pairs at once —
 * cannot drift apart: only the asking differs, never the answer.
 */
const MEMBERSHIP_IS_LIVE = `left_at is null
    and (role <> 'student' or status is not distinct from 'active')
    and (access_expires_at is null or access_expires_at > $3)`;

/**
 * Asked of one seat, as at the upgrade. $1 user, $2 cohort, $3 now.
 */
export const LIVE_MEMBERSHIP_QUERY = `select 1 from cohort_members
  where user_id = $1
    and cohort_id = $2
    and ${MEMBERSHIP_IS_LIVE}
  limit 1`;

/**
 * The same question for many seats at once, as the heartbeat's sweep asks
 * it: one query however many sockets are open. $1 user ids and $2 cohort
 * ids, paired by position; $3 now.
 */
export const LIVE_MEMBERSHIPS_QUERY = `select user_id, cohort_id from cohort_members
  where (user_id, cohort_id) in (
    select seat.user_id, seat.cohort_id
    from unnest($1::uuid[], $2::uuid[]) as seat(user_id, cohort_id)
  )
    and ${MEMBERSHIP_IS_LIVE}`;

/**
 * The one map an admin has published for people to enter on. The partial
 * unique index allows at most one non-retired entry map, so the order only
 * settles a database somebody wrote around the API.
 */
export const PUBLISHED_ENTRY_MAP_QUERY = `select key from maps
  where is_entry = true
    and retired_at is null
    and published_at is not null
  order by published_at desc
  limit 1`;

/**
 * A seat's membership row as it stands, many seats at once. No liveness here:
 * the door decides that with `isLiveMembership`, at the moment of the step.
 * $1 user ids and $2 cohort ids, paired by position.
 *
 * The group comes from wherever the membership holds one: a student's from
 * `mentorship_group_students`, a mentor's from `mentorship_groups`. The two
 * uniques behind those tables — one group per student per cohort, one per
 * mentor — and a row being either student-role or mentor-role are what keep
 * this one row per seat.
 */
export const MEMBERSHIP_ROWS_QUERY = `select members.user_id, members.cohort_id, members.role, members.left_at,
    members.status, members.access_expires_at, members.cohort_track_id,
    coalesce(student_group.mentorship_group_id, mentored_group.id) as mentorship_group_id
  from cohort_members as members
  left join mentorship_group_students as student_group
    on student_group.cohort_member_id = members.id
    and student_group.cohort_id = members.cohort_id
    and members.role = 'student'
  left join mentorship_groups as mentored_group
    on mentored_group.mentor_member_id = members.id
    and mentored_group.cohort_id = members.cohort_id
    and members.role = 'mentor'
  where (members.user_id, members.cohort_id) in (
    select seat.user_id, seat.cohort_id
    from unnest($1::uuid[], $2::uuid[]) as seat(user_id, cohort_id)
  )`;

/** campus-api's `NotificationKind` values, which its listing reads back. */
export const ENTRY_REQUEST_ADMITTED_KIND = 'entry_request_admitted';
export const ENTRY_REQUEST_DECLINED_KIND = 'entry_request_declined';

/**
 * $1 the asker, $2 the kind, $3 the request's id, $4 campus-api's
 * `EntryRequestContext` as JSON. Requests have no row, so the reference is
 * world's own id for one and the context says where it was. The conflict
 * target is campus-api's notifications_recipient_kind_reference_unique. A
 * repeat returns no row.
 */
export const ENTRY_REQUEST_NOTIFICATION_QUERY = `insert into notifications
    (recipient_id, kind, reference_type, reference_id, context)
  values ($1, $2, 'entry_request', $3, $4::jsonb)
  on conflict (recipient_id, kind, reference_type, reference_id) do nothing
  returning id, kind, reference_type, reference_id, context, created_at`;

/** What hearing defaults to in a proximity space with no radius set, in tiles. */
export const DEFAULT_AUDIBLE_RADIUS = 5;
export const DEFAULT_SUBSCRIBE_RADIUS = 6;

/** The two ways a space sounds, as `spaces.audio_mode` says. */
export type SpaceAudioMode = 'proximity' | 'boundary';

/** A space's door, and how people in it hear one another. */
export interface WorldSpace extends SpaceFacts {
  id: string;
  name: string;
  /** Null for no limit. */
  capacity: number | null;
  audioMode: SpaceAudioMode;
  audibleRadius: number;
  subscribeRadius: number;
  hysteresisFactor: number;
}

/** Somebody who entered through a room link, and one run of its event still to end. */
export interface RoomLinkPass {
  cohortId: string;
  spaceKey: string;
  userId: string;
  startsAt: Date;
  endsAt: Date;
}

/**
 * $1 the map's key, $2 now. One row per pass and run that is open or opens
 * within the hour; the doors read again every heartbeat, long before then.
 */
export const ROOM_LINK_PASSES_QUERY = `select room_links.cohort_id, spaces.key as space_key, room_link_passes.user_id,
    room_link_instances.starts_at, room_link_instances.ends_at
  from room_link_passes
  join room_links on room_links.id = room_link_passes.room_link_id
  join room_link_instances on room_link_instances.room_link_id = room_links.id
  join spaces on spaces.id = room_links.space_id
  join maps on maps.id = spaces.map_id
  where maps.key = $1
    and room_links.revoked_at is null
    and room_link_instances.cancelled_at is null
    and room_link_instances.ends_at > $2
    and room_link_instances.starts_at <= $2::timestamptz + interval '1 hour'`;

/** A `spaces` row as `SPACES_QUERY` reads it, before world decides what it means. */
export interface SpaceRow {
  id: string;
  key: string;
  name: string;
  kind: string | null;
  access: string;
  retired_at: Date | null;
  capacity: string | null;
  audio_mode: string;
  audible_radius: string | null;
  subscribe_radius: string | null;
  hysteresis_factor: string;
}

/**
 * The one place a row's audio mode becomes a mode world knows. The column is
 * an enum today, but world and the database do not deploy together, so a row
 * may carry a value this build has never heard of. That is read as `boundary`
 * — one room, not positional audio — so every check downstream compares two
 * known modes instead of treating the unknown as "not proximity".
 */
function audioModeOf(value: string): SpaceAudioMode {
  return value === 'proximity' ? 'proximity' : 'boundary';
}

/** A space row and the live entries on its list, as the gateway reads it. */
export function toWorldSpace(
  row: SpaceRow,
  grants: readonly SpaceGrantFacts[],
): WorldSpace {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    access: row.access,
    retiredAt: row.retired_at,
    locked: false,
    grants,
    capacity: row.capacity === null ? null : Number(row.capacity),
    audioMode: audioModeOf(row.audio_mode),
    audibleRadius:
      row.audible_radius === null
        ? DEFAULT_AUDIBLE_RADIUS
        : Number(row.audible_radius),
    subscribeRadius:
      row.subscribe_radius === null
        ? DEFAULT_SUBSCRIBE_RADIUS
        : Number(row.subscribe_radius),
    hysteresisFactor: Number(row.hysteresis_factor),
  };
}

/** Every space on one map, retired ones included. $1 the map's key. */
export const SPACES_QUERY = `select spaces.id, spaces.key, spaces.name, spaces.kind, spaces.access, spaces.retired_at,
    spaces.capacity, spaces.audio_mode, spaces.audible_radius, spaces.subscribe_radius, spaces.hysteresis_factor
  from spaces
  join maps on maps.id = spaces.map_id
  where maps.key = $1`;

/**
 * The entries on those spaces' lists that have not ended. One ended stays
 * ended, so leaving it out loses nothing. $1 space ids, $2 now.
 */
export const SPACE_LISTS_QUERY = `select space_id, user_id, cohort_track_id, cohort_role, system_role, mentorship_group_id, valid_from, valid_to
  from space_memberships
  where space_id = any($1::uuid[])
    and (valid_to is null or valid_to > $2)`;

/**
 * Ids come from campus-api, so they are UUIDs. Anything else is dropped before
 * it reaches a query, where it would fail the cast rather than return nothing.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeId(value: string): boolean {
  return UUID.test(value);
}

/**
 * A session token says who someone was when they signed in; it cannot say
 * whether they still belong here. campus-api re-reads the row on every
 * request for exactly that reason, and a socket that lives for hours needs
 * the same answer — otherwise a ban takes effect whenever the token happens
 * to expire, which is up to AUTH_SESSION_TTL_MINUTES later.
 *
 * Raw SQL rather than drizzle: every statement here is against tables
 * campus-api owns, and each is exported and run against its migrations in
 * accounts.spec.ts. If the schema moves to a shared package, these can move
 * to drizzle with it.
 */
export function createAccountLookup(env: Env): AccountLookup {
  const sql = postgres(env.DATABASE_URL, {
    max: env.WORLD_DB_POOL,
    // Lookups on the hot path, and one write nobody waits for: fail fast
    // rather than hold a socket waiting on a database that is not answering.
    connect_timeout: 5,
  });
  if (env.FF_OTEL_ENABLED) {
    installPostgresTracing(sql);
  }

  return {
    async find(userId: string): Promise<Account | null> {
      const rows = await sql.unsafe<
        {
          id: string;
          status: string;
          system_role: string;
          session_epoch: number;
          display_name: string | null;
          sprite_key: string | null;
        }[]
      >(ACCOUNT_QUERY, [userId]);
      const row = rows[0];
      return row
        ? {
            id: row.id,
            suspended: row.status === 'suspended',
            sessionEpoch: row.session_epoch,
            admin: hasAdminPowers(row.system_role),
            systemRole: row.system_role,
            displayName: row.display_name,
            spriteKey: spriteKeyOrNone(row.sprite_key),
          }
        : null;
    },
    async liveSessions(sessionIds, refreshedSince, now): Promise<Set<string>> {
      const ids = [...new Set(sessionIds)].filter((id) => UUID.test(id));
      if (ids.length === 0) {
        return new Set();
      }
      const rows = await sql.unsafe<{ family_id: string }[]>(
        LIVE_SESSIONS_QUERY,
        [ids, refreshedSince, now],
      );
      return new Set(rows.map((row) => row.family_id));
    },
    async publishedEntryMapKey(): Promise<string | null> {
      const rows = await sql.unsafe<{ key: string }[]>(
        PUBLISHED_ENTRY_MAP_QUERY,
      );
      return rows[0]?.key ?? null;
    },
    async onProfileChanged(listener): Promise<void> {
      // A connection of its own, kept open and re-listened on reconnect by
      // the driver. The payload is the account id campus-api changed.
      await sql.listen(PROFILE_CHANGED_CHANNEL, (userId) => listener(userId));
    },
    async liveMembership({ userId, cohortId }, now): Promise<boolean> {
      if (!looksLikeId(cohortId)) {
        return false;
      }
      const rows = await sql.unsafe<unknown[]>(LIVE_MEMBERSHIP_QUERY, [
        userId,
        cohortId,
        now,
      ]);
      return rows.length > 0;
    },
    async liveMemberships(seats, now): Promise<Set<string>> {
      // Every pair rides in one query, so an id the database cannot cast
      // would fail it for every socket at once. Dropped here, user and cohort
      // alike, where holding nothing is what a non-id could only have meant
      // anyway.
      const unique = new SeatMap<Seat>();
      for (const seat of seats) {
        if (looksLikeId(seat.userId) && looksLikeId(seat.cohortId)) {
          unique.set(seat, seat);
        }
      }
      const named = [...unique.values()];
      if (named.length === 0) {
        return new Set();
      }
      const rows = await sql.unsafe<{ user_id: string; cohort_id: string }[]>(
        LIVE_MEMBERSHIPS_QUERY,
        [
          named.map((seat) => seat.userId),
          named.map((seat) => seat.cohortId),
          now,
        ],
      );
      return new Set(
        rows.map((row) =>
          seatKey({ userId: row.user_id, cohortId: row.cohort_id }),
        ),
      );
    },
    async memberships(seats): Promise<Map<string, CohortMembershipFacts>> {
      // As in liveMemberships: a pair the database cannot cast would fail
      // the query for every socket, so it is dropped here.
      const unique = new SeatMap<Seat>();
      for (const seat of seats) {
        if (looksLikeId(seat.userId) && looksLikeId(seat.cohortId)) {
          unique.set(seat, seat);
        }
      }
      const named = [...unique.values()];
      if (named.length === 0) {
        return new Map();
      }
      const rows = await sql.unsafe<
        {
          user_id: string;
          cohort_id: string;
          role: string;
          left_at: Date | null;
          status: string | null;
          access_expires_at: Date | null;
          cohort_track_id: string | null;
          mentorship_group_id: string | null;
        }[]
      >(MEMBERSHIP_ROWS_QUERY, [
        named.map((seat) => seat.userId),
        named.map((seat) => seat.cohortId),
      ]);
      return new Map(
        rows.map((row) => [
          seatKey({ userId: row.user_id, cohortId: row.cohort_id }),
          {
            cohortId: row.cohort_id,
            role: row.role,
            leftAt: row.left_at,
            status: row.status,
            accessExpiresAt: row.access_expires_at,
            trackId: row.cohort_track_id,
            mentorshipGroupId: row.mentorship_group_id,
          },
        ]),
      );
    },
    async spacesOn(mapKey, now): Promise<Map<string, WorldSpace>> {
      const spaces = await sql.unsafe<SpaceRow[]>(SPACES_QUERY, [mapKey]);
      const lists = new Map<string, SpaceGrantFacts[]>(
        spaces.map((space) => [space.id, []]),
      );
      if (spaces.length > 0) {
        const entries = await sql.unsafe<
          {
            space_id: string;
            user_id: string | null;
            cohort_track_id: string | null;
            cohort_role: string | null;
            system_role: string | null;
            mentorship_group_id: string | null;
            valid_from: Date;
            valid_to: Date | null;
          }[]
        >(SPACE_LISTS_QUERY, [spaces.map((space) => space.id), now]);
        for (const entry of entries) {
          lists.get(entry.space_id)?.push({
            toUserId: entry.user_id,
            toTrackId: entry.cohort_track_id,
            toCohortRole: entry.cohort_role,
            toSystemRole: entry.system_role,
            toGroupId: entry.mentorship_group_id,
            validFrom: entry.valid_from,
            validTo: entry.valid_to,
          });
        }
      }
      return new Map(
        spaces.map((space) => [
          space.key,
          toWorldSpace(space, lists.get(space.id) ?? []),
        ]),
      );
    },
    async roomLinkPassesOn(mapKey, now): Promise<RoomLinkPass[]> {
      const rows = await sql.unsafe<
        {
          cohort_id: string;
          space_key: string;
          user_id: string;
          starts_at: Date;
          ends_at: Date;
        }[]
      >(ROOM_LINK_PASSES_QUERY, [mapKey, now]);
      return rows.map((row) => ({
        cohortId: row.cohort_id,
        spaceKey: row.space_key,
        userId: row.user_id,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
      }));
    },
    async onDesksChanged(listener): Promise<void> {
      // As for spaces: a change made while the driver was reconnecting told
      // nobody, so every cohort fetches again once it is back.
      await sql.listen(
        DESKS_CHANGED_CHANNEL,
        (cohortId) => listener(cohortId === '' ? null : cohortId),
        () => listener(null),
      );
    },
    async onSpacesChanged(listener, reconnected): Promise<void> {
      // Called on every notification, and again each time the driver
      // subscribes: a change made while it was reconnecting sent its word to
      // nobody, so reading again on the way back in is what catches it.
      await sql.listen(
        SPACES_CHANGED_CHANNEL,
        (payload) => listener(payload),
        () => (reconnected ? reconnected() : listener('')),
      );
    },
    async notifyEntryRequestAnswered(answer) {
      const [row] = await sql.unsafe<
        {
          id: string;
          kind: string;
          reference_type: string;
          reference_id: string;
          context: { cohortId: string; spaceKey: string } | null;
          created_at: Date;
        }[]
      >(ENTRY_REQUEST_NOTIFICATION_QUERY, [
        answer.askerId,
        answer.admitted
          ? ENTRY_REQUEST_ADMITTED_KIND
          : ENTRY_REQUEST_DECLINED_KIND,
        answer.requestId,
        JSON.stringify({
          cohortId: answer.cohortId,
          spaceKey: answer.spaceKey,
        }),
      ]);
      return row
        ? {
            id: row.id,
            kind: row.kind,
            referenceType: row.reference_type,
            referenceId: row.reference_id,
            context: row.context,
            createdAt: row.created_at,
          }
        : undefined;
    },
    async close(): Promise<void> {
      await sql.end();
    },
  };
}
