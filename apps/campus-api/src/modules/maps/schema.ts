import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { cohortTracks } from '../cohorts/schema.js';
import { users } from '../users/schema.js';

/*
 * What the database knows of the campus map: that a map and its spaces
 * exist, and how each space behaves. Nothing about where anything is.
 *
 * The map files, their versions and every piece of geometry — walls, the
 * spawn, a space's bounds, portals — are published to Sanity and read from
 * there through campus-world-map. A row here exists so that other tables
 * have a map or a space to point at, and so the rules a drawing cannot hold
 * (who may enter, how audio works, how many fit) have somewhere to live. The
 * two are joined by key: a map's ID in Sanity, and a space's name in Tiled.
 */

/**
 * What sort of room a space is. Set by an admin: the class the designer gave
 * the object in Tiled is only a starting suggestion, taken when it names one
 * of these.
 */
export enum SpaceKind {
  Open = 'open',
  Classroom = 'classroom',
  MeetingRoom = 'meeting_room',
  MentorPod = 'mentor_pod',
  LiveCoding = 'live_coding',
  Desk = 'desk',
  TownHall = 'town_hall',
  NoticeBoard = 'notice_board',
  Stage = 'stage',
  HelpDesk = 'help_desk',
}

/**
 * How people in a space hear one another: by distance, everybody in the
 * space alike, or a few speaking to everybody.
 */
export enum AudioMode {
  Proximity = 'proximity',
  Boundary = 'boundary',
  Broadcast = 'broadcast',
}

/** Who may walk in. `invite` and `request` are resolved by space_memberships. */
export enum SpaceAccess {
  Open = 'open',
  Cohort = 'cohort',
  Invite = 'invite',
  Request = 'request',
}

/** What somebody standing outside a space is shown of the people inside. */
export enum OutsiderVisibility {
  Hidden = 'hidden',
  AvatarsVisible = 'avatars_visible',
  Full = 'full',
}

/** Who may speak or share in a space. */
export enum PublishPolicy {
  All = 'all',
  Staff = 'staff',
  GrantOnly = 'grant_only',
}

export const spaceKindEnum = pgEnum('space_kind', SpaceKind);
export const audioModeEnum = pgEnum('audio_mode', AudioMode);
export const spaceAccessEnum = pgEnum('space_access', SpaceAccess);
export const outsiderVisibilityEnum = pgEnum(
  'outsider_visibility',
  OutsiderVisibility,
);
export const publishPolicyEnum = pgEnum('publish_policy', PublishPolicy);

export const maps = pgTable(
  'maps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The map's ID in Sanity: what it is published as, and what portals on
     * other maps call it.
     */
    key: varchar('key', { length: 64 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    /** The map people enter the campus on: the one published with a spawn. */
    isEntry: boolean('is_entry').notNull().default(false),
    /**
     * Set when the map is no longer published. Never deleted: its spaces,
     * and everything that ever pointed at them, are still history.
     */
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('maps_key_unique').on(table.key),
    // One campus, one way in. A retired map does not count, so the entry map
    // can be replaced by another without deleting it.
    uniqueIndex('maps_single_entry')
      .on(table.isEntry)
      .where(sql`${table.isEntry} and ${table.retiredAt} is null`),
  ],
);

export const spaces = pgTable(
  'spaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mapId: uuid('map_id')
      .notNull()
      .references(() => maps.id),
    /**
     * The object's name in Tiled, unique on its map. Renaming it there makes
     * it a different space here.
     */
    key: varchar('key', { length: 64 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    /**
     * Null until an admin sets it, or the map suggested a kind this knows. A
     * space with no kind is not set up yet, and nobody but admins may enter.
     */
    kind: spaceKindEnum('kind'),
    /**
     * Marks a map's default space: the one for every tile inside no drawn
     * space, so the corridors and the grounds have an audio room too. It is
     * drawn nowhere; it is whatever is left.
     *
     * A map has at most one, which is all the database can say. That every
     * map has one is for whatever writes its rows to see to.
     */
    isMapDefault: boolean('is_map_default').notNull().default(false),

    audioMode: audioModeEnum('audio_mode').notNull(),
    access: spaceAccessEnum('access').notNull(),
    outsiderVisibility: outsiderVisibilityEnum('outsider_visibility')
      .notNull()
      .default(OutsiderVisibility.AvatarsVisible),
    /** Null for no limit. */
    capacity: integer('capacity'),
    publishPolicy: publishPolicyEnum('publish_policy')
      .notNull()
      .default(PublishPolicy.All),

    /**
     * In tiles. How far a voice carries: the client fades it to nothing
     * across this distance.
     */
    audibleRadius: numeric('audible_radius', { precision: 6, scale: 2 }),
    /**
     * In tiles, and a little more than audible_radius. This is what the
     * media server subscribes people by, so it is what decides the bill.
     */
    subscribeRadius: numeric('subscribe_radius', { precision: 6, scale: 2 }),
    /**
     * How much further than subscribe_radius somebody must go before they
     * are unsubscribed, so standing on the line does not flicker.
     */
    hysteresisFactor: numeric('hysteresis_factor', { precision: 4, scale: 2 })
      .notNull()
      .default('1.2'),

    /**
     * Set when the space is no longer on its map. Never deleted: memberships,
     * sessions and schedules still point at it.
     */
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Retired or not: a key that comes back is the same space coming back,
    // with the settings it had.
    uniqueIndex('spaces_map_key_unique').on(table.mapId, table.key),
    // Retired ones count, unlike the town hall and notice board below: a
    // map's default keeps one key for good, is retired only with its map and
    // comes back as the same row, so there is never a second to make room
    // for.
    uniqueIndex('spaces_one_default_per_map')
      .on(table.mapId)
      .where(sql`${table.isMapDefault}`),
    // The campus has one town hall and one notice board, wherever they are.
    uniqueIndex('spaces_single_town_hall')
      .on(table.kind)
      .where(
        sql`${table.kind} = ${sql.raw(`'${SpaceKind.TownHall}'`)} and ${table.retiredAt} is null`,
      ),
    uniqueIndex('spaces_single_notice_board')
      .on(table.kind)
      .where(
        sql`${table.kind} = ${sql.raw(`'${SpaceKind.NoticeBoard}'`)} and ${table.retiredAt} is null`,
      ),
    // What is left of a map once the rooms are drawn is corridors and
    // grounds. Gating it would shut people out of the way to everywhere
    // else.
    check(
      'spaces_default_is_open',
      sql`not ${table.isMapDefault} or ${table.access} = ${sql.raw(`'${SpaceAccess.Open}'`)}`,
    ),
    // A broadcast is a few people speaking to a room. With everybody allowed
    // to publish it is not one.
    check(
      'spaces_broadcast_restricts_publish',
      sql`${table.audioMode} <> ${sql.raw(`'${AudioMode.Broadcast}'`)} or ${table.publishPolicy} <> ${sql.raw(`'${PublishPolicy.All}'`)}`,
    ),
    check(
      'spaces_capacity_positive',
      sql`${table.capacity} is null or ${table.capacity} > 0`,
    ),
  ],
);

/**
 * Somebody's standing permission to enter a space: a person, or everybody on
 * a cohort's track. What the `invite` and `request` kinds of access are
 * answered from.
 *
 * It holds a span, not a switch: ending access sets valid_to, and the row
 * stays as the record that they once had it.
 */
export const spaceMemberships = pgTable(
  'space_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    cohortTrackId: uuid('cohort_track_id').references(() => cohortTracks.id),
    userId: uuid('user_id').references(() => users.id),
    /** Null when no person granted it: the seed, a sync. */
    grantedBy: uuid('granted_by').references(() => users.id),
    validFrom: timestamp('valid_from', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Null while it has no end. */
    validTo: timestamp('valid_to', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('space_memberships_space_idx').on(table.spaceId),
    index('space_memberships_user_idx').on(table.userId),
    index('space_memberships_cohort_track_idx').on(table.cohortTrackId),
    // A grant is to one person or to one track, never both and never
    // neither: with both it is unclear whose access ends when one of them
    // does, and with neither it admits nobody.
    check(
      'space_memberships_one_subject',
      sql`(${table.cohortTrackId} is null) <> (${table.userId} is null)`,
    ),
    check(
      'space_memberships_valid_window',
      sql`${table.validTo} is null or ${table.validTo} > ${table.validFrom}`,
    ),
  ],
);

export type CampusMap = typeof maps.$inferSelect;
export type NewCampusMap = typeof maps.$inferInsert;
export type Space = typeof spaces.$inferSelect;
export type NewSpace = typeof spaces.$inferInsert;
export type SpaceMembership = typeof spaceMemberships.$inferSelect;
export type NewSpaceMembership = typeof spaceMemberships.$inferInsert;
