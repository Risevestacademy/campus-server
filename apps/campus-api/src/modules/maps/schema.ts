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

import { cohortRoleEnum, cohortTracks } from '../cohorts/schema.js';
import { mentorshipGroups } from '../mentorship-groups/schema.js';
import { systemRoleEnum, users } from '../users/schema.js';

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
 * How people in a space hear one another: by distance, or everybody in the
 * space alike. Sound never crosses a space's edge either way. There is no
 * broadcast space: an admin speaks to the whole campus instead.
 */
export enum AudioMode {
  Proximity = 'proximity',
  Boundary = 'boundary',
}

/**
 * Who may walk in. A `normal` space admits anybody in the campus, unless the
 * people inside have locked it; a `designated` one admits whoever its list in
 * space_memberships names.
 */
export enum SpaceAccess {
  Normal = 'normal',
  Designated = 'designated',
}

export const spaceKindEnum = pgEnum('space_kind', SpaceKind);
export const audioModeEnum = pgEnum('audio_mode', AudioMode);
export const spaceAccessEnum = pgEnum('space_access', SpaceAccess);

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
    // At most one way into the campus; the sync is what makes it exactly
    // one, as the database cannot without refusing every write that passes
    // through having none. A retired map does not count, so the entry map can
    // be replaced by another without deleting it.
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
    /** Null for no limit. */
    capacity: integer('capacity'),

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
      'spaces_default_is_normal',
      sql`not ${table.isMapDefault} or ${table.access} = ${sql.raw(`'${SpaceAccess.Normal}'`)}`,
    ),
    check(
      'spaces_capacity_positive',
      sql`${table.capacity} is null or ${table.capacity} > 0`,
    ),
  ],
);

/**
 * One entry on a designated space's list: a person, everybody on a cohort's
 * track, everybody holding a cohort role, everybody holding a system role, or
 * everybody in a mentorship group. Any one live entry that names somebody
 * lets them in.
 *
 * A space belongs to no cohort, so an entry naming a role reaches that role
 * in every cohort's copy of the campus; one naming a track or a mentorship
 * group reaches only that cohort's people, and a group only its own students
 * and mentor.
 *
 * It holds a span, not a switch: ending access sets valid_to, and the row
 * stays as the record that they once had it — until the subject itself goes:
 * a track detached from its cohort, or a mentorship group deleted, clears
 * its ended entries and leaves the audit log as their record.
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
    /** Everybody holding this role in the cohort being walked. */
    cohortRole: cohortRoleEnum('cohort_role'),
    /** Everybody holding this system role, whichever cohort they walk. */
    systemRole: systemRoleEnum('system_role'),
    /** Everybody in this mentorship group: its students and its mentor. */
    mentorshipGroupId: uuid('mentorship_group_id').references(
      () => mentorshipGroups.id,
    ),
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
    index('space_memberships_mentorship_group_idx').on(table.mentorshipGroupId),
    // An entry names exactly one subject: with two it is unclear whose
    // access ends when one of them does, and with none it admits nobody.
    check(
      'space_memberships_one_subject',
      sql`num_nonnulls(${table.userId}, ${table.cohortTrackId}, ${table.cohortRole}, ${table.systemRole}, ${table.mentorshipGroupId}) = 1`,
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
