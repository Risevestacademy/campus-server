import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import {
  CohortRole,
  cohortMembers,
  cohortTracks,
  cohorts,
} from '../cohorts/schema.js';
import { AudioMode, SpaceAccess, maps, spaces } from '../maps/schema.js';
import { mentorshipGroups } from '../mentorship-groups/schema.js';
import {
  RoomLinkAudience,
  roomLinkInstances,
  roomLinks,
} from '../room-links/schema.js';
import { tracks } from '../tracks/schema.js';
import { users } from '../users/schema.js';
import {
  AttendanceSource,
  AttendanceStatus,
  attendance,
  attendanceOverrides,
  attendanceTallies,
} from './schema.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);

const db = drizzle(new PGlite());

async function expectViolation(
  write: Promise<unknown>,
  constraint: string,
): Promise<void> {
  let error: unknown;
  try {
    await write;
  } catch (caught) {
    error = caught;
  }

  const detail =
    error instanceof Error
      ? `${error.message} ${(error.cause as Error | undefined)?.message ?? ''}`
      : String(error);

  expect(
    error,
    `expected a violation of ${constraint}, but the write succeeded`,
  ).toBeDefined();
  expect(detail).toContain(constraint);
}

const HOUR = 3_600_000;
const start = new Date('2026-11-02T10:00:00Z');
const end = new Date(start.getTime() + HOUR);

let cohortId: string;
let otherCohortId: string;
let spaceId: string;
let userId: string;
let cohortTrackId: string;
let otherCohortTrackId: string;
let groupId: string;
let codes = 0;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(
    sql`truncate attendance_overrides, attendance, attendance_tallies, room_link_instances, room_links, mentorship_groups, cohort_members, cohort_tracks, tracks, spaces, maps, cohorts, users cascade`,
  );
  [{ id: cohortId }] = await db
    .insert(cohorts)
    .values({ name: 'C1', code: 'C1' })
    .returning();
  [{ id: otherCohortId }] = await db
    .insert(cohorts)
    .values({ name: 'C2', code: 'C2' })
    .returning();
  const [map] = await db
    .insert(maps)
    .values({ key: 'campus', name: 'Campus', isEntry: true })
    .returning();
  [{ id: spaceId }] = await db
    .insert(spaces)
    .values({
      mapId: map.id,
      key: 'lecture',
      name: 'Lecture',
      audioMode: AudioMode.Boundary,
      access: SpaceAccess.Normal,
    })
    .returning();
  [{ id: userId }] = await db
    .insert(users)
    .values({ email: 'ada@campus.local' })
    .returning();
  const [track] = await db
    .insert(tracks)
    .values({ name: 'Backend', code: 'BE' })
    .returning();
  [{ id: cohortTrackId }] = await db
    .insert(cohortTracks)
    .values({ cohortId, trackId: track.id })
    .returning();
  [{ id: otherCohortTrackId }] = await db
    .insert(cohortTracks)
    .values({ cohortId: otherCohortId, trackId: track.id })
    .returning();
  const [mentor] = await db
    .insert(cohortMembers)
    .values({ cohortId, userId, role: CohortRole.Mentor })
    .returning();
  [{ id: groupId }] = await db
    .insert(mentorshipGroups)
    .values({ cohortId, mentorMemberId: mentor.id, name: 'Pod A' })
    .returning();
});

function link(overrides: Partial<typeof roomLinks.$inferInsert> = {}) {
  codes += 1;
  return db
    .insert(roomLinks)
    .values({
      code: `code${codes}`,
      cohortId,
      spaceId,
      title: 'Standup',
      createdBy: userId,
      ...overrides,
    })
    .returning();
}

async function tally(
  roomLinkId: string,
  overrides: Partial<typeof attendanceTallies.$inferInsert> = {},
) {
  codes += 1;
  const [instance] = await db
    .insert(roomLinkInstances)
    .values({
      roomLinkId,
      organizerId: userId,
      googleEventId: `event_${codes}`,
      startsAt: start,
      endsAt: end,
    })
    .returning();
  return db
    .insert(attendanceTallies)
    .values({
      instanceId: instance.id,
      startsAt: start,
      endsAt: end,
      talliedAt: new Date(end.getTime() + 300_000),
      ...overrides,
    })
    .returning();
}

describe('room link audience', () => {
  it('is the whole cohort unless said otherwise', async () => {
    const [row] = await link();

    expect(row).toMatchObject({
      audience: RoomLinkAudience.Cohort,
      cohortTrackId: null,
      mentorshipGroupId: null,
    });
  });

  it('refuses an audience it does not know', async () => {
    await expectViolation(
      link({ audience: 'everyone' as RoomLinkAudience }),
      'room_links_audience_known',
    );
  });

  it('names the track a track link is for, and only then', async () => {
    await link({ audience: RoomLinkAudience.CohortTrack, cohortTrackId });

    await expectViolation(
      link({ audience: RoomLinkAudience.CohortTrack }),
      'room_links_track_matches_audience',
    );
    await expectViolation(
      link({ cohortTrackId }),
      'room_links_track_matches_audience',
    );
  });

  it('names the pod a pod link is for, and only then', async () => {
    await link({
      audience: RoomLinkAudience.MentorshipGroup,
      mentorshipGroupId: groupId,
    });

    await expectViolation(
      link({ audience: RoomLinkAudience.MentorshipGroup }),
      'room_links_group_matches_audience',
    );
    await expectViolation(
      link({ mentorshipGroupId: groupId }),
      'room_links_group_matches_audience',
    );
  });

  it('lets a revoked link lose its track or pod', async () => {
    const [byTrack] = await link({
      audience: RoomLinkAudience.CohortTrack,
      cohortTrackId,
    });
    const [byGroup] = await link({
      audience: RoomLinkAudience.MentorshipGroup,
      mentorshipGroupId: groupId,
    });

    await expectViolation(
      db
        .update(roomLinks)
        .set({ cohortTrackId: null })
        .where(sql`${roomLinks.id} = ${byTrack.id}`),
      'room_links_track_matches_audience',
    );

    await db
      .update(roomLinks)
      .set({ revokedAt: new Date(), cohortTrackId: null })
      .where(sql`${roomLinks.id} = ${byTrack.id}`);
    await db
      .update(roomLinks)
      .set({ revokedAt: new Date(), mentorshipGroupId: null })
      .where(sql`${roomLinks.id} = ${byGroup.id}`);
  });

  it('refuses a track or pod of another cohort', async () => {
    await expectViolation(
      link({
        audience: RoomLinkAudience.CohortTrack,
        cohortTrackId: otherCohortTrackId,
      }),
      'room_links_cohort_track_fk',
    );
    await expectViolation(
      link({
        cohortId: otherCohortId,
        audience: RoomLinkAudience.MentorshipGroup,
        mentorshipGroupId: groupId,
      }),
      'room_links_mentorship_group_fk',
    );
  });
});

describe('attendance tallies', () => {
  it('ends after it starts, and is tallied no earlier than its end', async () => {
    const [{ id }] = await link();

    await expectViolation(
      tally(id, { endsAt: start }),
      'attendance_tallies_window',
    );
    await expectViolation(
      tally(id, { talliedAt: new Date(end.getTime() - 1) }),
      'attendance_tallies_after_end',
    );
  });
});

describe('attendance', () => {
  let instanceId: string;

  beforeEach(async () => {
    const [{ id }] = await link();
    [{ instanceId }] = await tally(id);
  });

  const row = (overrides: Partial<typeof attendance.$inferInsert> = {}) =>
    db
      .insert(attendance)
      .values({
        instanceId,
        userId,
        presentSeconds: 3_000,
        status: AttendanceStatus.Present,
        ...overrides,
      })
      .returning();

  it('is derived unless corrected', async () => {
    const [created] = await row();

    expect(created.source).toBe(AttendanceSource.Derived);
  });

  it('is one row per person per run', async () => {
    await row();

    await expectViolation(row(), 'attendance_instance_user_unique');
  });

  it('never counts negative time', async () => {
    await expectViolation(
      row({ presentSeconds: -1 }),
      'attendance_present_seconds',
    );
  });

  it('keeps a correction only with a reason', async () => {
    const [{ id: attendanceId }] = await row();
    const correction = (reason: string) =>
      db.insert(attendanceOverrides).values({
        attendanceId,
        changedBy: userId,
        oldStatus: AttendanceStatus.Present,
        newStatus: AttendanceStatus.Absent,
        reason,
      });

    await correction('Was on the phone with the professor');
    await expectViolation(
      correction('   '),
      'attendance_overrides_reason_not_blank',
    );
  });
});
