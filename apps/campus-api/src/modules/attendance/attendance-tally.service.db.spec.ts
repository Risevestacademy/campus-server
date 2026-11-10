import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import type { PinoLogger } from 'nestjs-pino';

import type { Scheduler } from '../../infra/scheduler/scheduler.js';
import { sessionParticipants, sessions } from '../calls/schema.js';
import {
  CohortRole,
  StudentStatus,
  cohortMembers,
  cohortTracks,
  cohorts,
} from '../cohorts/schema.js';
import { AudioMode, SpaceAccess, maps, spaces } from '../maps/schema.js';
import {
  mentorshipGroupStudents,
  mentorshipGroups,
} from '../mentorship-groups/schema.js';
import {
  RoomLinkAudience,
  roomLinkInstances,
  roomLinks,
} from '../room-links/schema.js';
import { tracks } from '../tracks/schema.js';
import { users } from '../users/schema.js';
import {
  AttendanceTallyService,
  TALLY_DELAY_MS,
  attendanceStatus,
} from './attendance-tally.service.js';
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
const logger = { info: vi.fn(), error: vi.fn(), setContext: vi.fn() };
const tally = new AttendanceTallyService(
  db as never,
  { register: vi.fn() } as unknown as Scheduler,
  logger as unknown as PinoLogger,
);

const MINUTE = 60_000;
const START = new Date('2026-11-10T10:00:00Z');
const END = new Date(START.getTime() + 60 * MINUTE);
const AFTER = new Date(END.getTime() + TALLY_DELAY_MS);
const at = (minutes: number) => new Date(START.getTime() + minutes * MINUTE);

let cohortId: string;
let otherCohortId: string;
let spaceId: string;
let otherSpaceId: string;
let trackA: string;
let trackB: string;
let mentorId: string;
let counter = 0;

async function person(email: string) {
  const [row] = await db.insert(users).values({ email }).returning();
  return row.id;
}

async function student(
  name: string,
  overrides: Partial<typeof cohortMembers.$inferInsert> = {},
) {
  const userId = await person(`${name}@campus.local`);
  const [member] = await db
    .insert(cohortMembers)
    .values({
      cohortId,
      userId,
      role: CohortRole.Student,
      cohortTrackId: trackA,
      status: StudentStatus.Active,
      joinedAt: at(-7 * 24 * 60),
      ...overrides,
    })
    .returning();
  return { userId, memberId: member.id };
}

async function run(
  overrides: Partial<typeof roomLinks.$inferInsert> = {},
  times: { startsAt: Date; endsAt: Date } = { startsAt: START, endsAt: END },
) {
  counter += 1;
  const [link] = await db
    .insert(roomLinks)
    .values({
      code: `code${counter}`.padEnd(10, 'x'),
      cohortId,
      spaceId,
      title: 'Class',
      createdBy: mentorId,
      ...overrides,
    })
    .returning();
  const [instance] = await db
    .insert(roomLinkInstances)
    .values({
      roomLinkId: link.id,
      organizerId: mentorId,
      googleEventId: `event_${counter}`,
      ...times,
    })
    .returning();
  return instance.id;
}

/** One stretch in a call: minutes from the run's start, or open. */
async function inCall(
  userId: string,
  from: number,
  to: number | null,
  where: { cohort?: string; space?: string } = {},
) {
  counter += 1;
  const [session] = await db
    .insert(sessions)
    .values({
      cohortId: where.cohort ?? cohortId,
      spaceId: where.space ?? spaceId,
      providerRoomId: `room-${counter}`,
      openedAt: at(from),
      closedAt: to === null ? null : at(to),
    })
    .returning();
  await db.insert(sessionParticipants).values({
    sessionId: session.id,
    userId,
    providerIdentity: `${userId}:${counter}`,
    joinedAt: at(from),
    leftAt: to === null ? null : at(to),
  });
}

const rows = (instanceId: string) =>
  db
    .select({
      userId: attendance.userId,
      presentSeconds: attendance.presentSeconds,
      status: attendance.status,
      source: attendance.source,
    })
    .from(attendance)
    .where(eq(attendance.instanceId, instanceId));

const byUser = async (instanceId: string) =>
  new Map((await rows(instanceId)).map((r) => [r.userId, r]));

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  vi.resetAllMocks();
  await db.execute(
    sql`truncate attendance_overrides, attendance, attendance_tallies, room_link_instances, room_links, session_participants, sessions, mentorship_group_students, mentorship_groups, cohort_members, cohort_tracks, tracks, spaces, maps, cohorts, users cascade`,
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
  [{ id: spaceId }, { id: otherSpaceId }] = await db
    .insert(spaces)
    .values(
      ['lecture', 'library'].map((key) => ({
        mapId: map.id,
        key,
        name: key,
        audioMode: AudioMode.Boundary,
        access: SpaceAccess.Normal,
      })),
    )
    .returning();
  const [backend, design] = await db
    .insert(tracks)
    .values([
      { name: 'Backend', code: 'BE' },
      { name: 'Design', code: 'DE' },
    ])
    .returning();
  [{ id: trackA }, { id: trackB }] = await db
    .insert(cohortTracks)
    .values([
      { cohortId, trackId: backend.id },
      { cohortId, trackId: design.id },
    ])
    .returning();
  mentorId = await person('mentor@campus.local');
  await db
    .insert(cohortMembers)
    .values({ cohortId, userId: mentorId, role: CohortRole.Mentor });
});

it('marks present at three quarters of the run, partial above none, absent at none', () => {
  expect(attendanceStatus(2700, 3600)).toBe(AttendanceStatus.Present);
  expect(attendanceStatus(2699, 3600)).toBe(AttendanceStatus.Partial);
  expect(attendanceStatus(1, 3600)).toBe(AttendanceStatus.Partial);
  expect(attendanceStatus(0, 3600)).toBe(AttendanceStatus.Absent);
});

describe('tallying a run', () => {
  it('counts each student’s time in the call inside the run, early arrival and lingering left out', async () => {
    const ada = await student('ada');
    const grace = await student('grace');
    const alan = await student('alan');
    const instanceId = await run();
    await inCall(ada.userId, -10, 70);
    await inCall(grace.userId, 0, 10);
    await inCall(grace.userId, 30, 40);

    await tally.tallyDue(AFTER);

    const got = await byUser(instanceId);
    expect(got.get(ada.userId)).toMatchObject({
      presentSeconds: 3600,
      status: AttendanceStatus.Present,
      source: AttendanceSource.Derived,
    });
    expect(got.get(grace.userId)).toMatchObject({
      presentSeconds: 1200,
      status: AttendanceStatus.Partial,
    });
    expect(got.get(alan.userId)).toMatchObject({
      presentSeconds: 0,
      status: AttendanceStatus.Absent,
    });
    const [kept] = await db.select().from(attendanceTallies);
    expect(kept).toMatchObject({
      instanceId,
      startsAt: START,
      endsAt: END,
      talliedAt: AFTER,
    });
  });

  it('waits until a few minutes after the run ends, for late word of who left', async () => {
    await student('ada');
    await run();

    await tally.tallyDue(new Date(AFTER.getTime() - 1));

    expect(await db.select().from(attendanceTallies)).toEqual([]);
  });

  it('counts somebody still in the call when it was tallied, up to the end', async () => {
    const ada = await student('ada');
    const instanceId = await run();
    await inCall(ada.userId, 15, null);

    await tally.tallyDue(AFTER);

    expect((await byUser(instanceId)).get(ada.userId)?.presentSeconds).toBe(
      45 * 60,
    );
  });

  it('never counts more than the run, even across overlapping stretches', async () => {
    const ada = await student('ada');
    const instanceId = await run();
    await inCall(ada.userId, 0, 60);
    await inCall(ada.userId, 59, 60);

    await tally.tallyDue(AFTER);

    expect((await byUser(instanceId)).get(ada.userId)?.presentSeconds).toBe(
      3600,
    );
  });

  it('counts only this cohort’s call in this space', async () => {
    const ada = await student('ada');
    const instanceId = await run();
    await inCall(ada.userId, 0, 60, { space: otherSpaceId });
    await inCall(ada.userId, 0, 60, { cohort: otherCohortId });

    await tally.tallyDue(AFTER);

    expect((await byUser(instanceId)).get(ada.userId)?.status).toBe(
      AttendanceStatus.Absent,
    );
  });

  it('expects students only, and only those in the cohort when the run started', async () => {
    const ada = await student('ada');
    const late = await student('late', { joinedAt: at(5) });
    const gone = await student('gone', {
      leftAt: at(-60),
      status: StudentStatus.Withdrawn,
      dismissalReason: 'Moved away',
    });
    const leftLater = await student('left-later', {
      leftAt: at(24 * 60),
      status: StudentStatus.Withdrawn,
      dismissalReason: 'Moved away',
    });
    const instanceId = await run();
    await inCall(mentorId, 0, 60);

    await tally.tallyDue(AFTER);

    expect([...(await byUser(instanceId)).keys()].sort()).toEqual(
      [ada.userId, leftLater.userId].sort(),
    );
    expect(late && gone).toBeTruthy();
  });

  it('expects one track’s students at a track’s run', async () => {
    const ada = await student('ada');
    await student('designer', { cohortTrackId: trackB });
    const instanceId = await run({
      audience: RoomLinkAudience.CohortTrack,
      cohortTrackId: trackA,
    });

    await tally.tallyDue(AFTER);

    expect([...(await byUser(instanceId)).keys()]).toEqual([ada.userId]);
  });

  it('expects one pod’s students at a pod’s run', async () => {
    const ada = await student('ada');
    await student('grace');
    const [mentor] = await db
      .select({ id: cohortMembers.id })
      .from(cohortMembers)
      .where(eq(cohortMembers.userId, mentorId));
    const [pod] = await db
      .insert(mentorshipGroups)
      .values({ cohortId, mentorMemberId: mentor.id, name: 'Pod A' })
      .returning();
    await db.insert(mentorshipGroupStudents).values({
      mentorshipGroupId: pod.id,
      cohortId,
      cohortMemberId: ada.memberId,
    });
    const instanceId = await run({
      audience: RoomLinkAudience.MentorshipGroup,
      mentorshipGroupId: pod.id,
    });

    await tally.tallyDue(AFTER);

    expect([...(await byUser(instanceId)).keys()]).toEqual([ada.userId]);
  });

  it('tallies a run once, and leaves cancelled ones alone', async () => {
    await student('ada');
    const instanceId = await run();
    const cancelled = await run();
    await db
      .update(roomLinkInstances)
      .set({ cancelledAt: at(-60) })
      .where(eq(roomLinkInstances.id, cancelled));

    await tally.tallyDue(AFTER);
    await tally.tallyDue(new Date(AFTER.getTime() + MINUTE));

    const tallies = await db.select().from(attendanceTallies);
    expect(tallies.map((t) => [t.instanceId, t.talliedAt])).toEqual([
      [instanceId, AFTER],
    ]);
  });
});

describe('after a tally', () => {
  let ada: { userId: string; memberId: string };
  let grace: { userId: string; memberId: string };
  let instanceId: string;

  beforeEach(async () => {
    ada = await student('ada');
    grace = await student('grace');
    instanceId = await run();
    await inCall(ada.userId, 0, 60);
    await tally.tallyDue(AFTER);
  });

  async function correct(userId: string, status: AttendanceStatus) {
    const [row] = await db
      .select()
      .from(attendance)
      .where(eq(attendance.userId, userId));
    await db
      .update(attendance)
      .set({ status, source: AttendanceSource.Override })
      .where(eq(attendance.id, row.id));
    await db.insert(attendanceOverrides).values({
      attendanceId: row.id,
      changedBy: mentorId,
      oldStatus: row.status,
      newStatus: status,
      reason: 'Was on a call with me',
    });
  }

  it('tallies a run again once it moves, keeping a correction’s status', async () => {
    await correct(grace.userId, AttendanceStatus.Present);
    await db
      .update(roomLinkInstances)
      .set({ startsAt: at(30), endsAt: at(90) })
      .where(eq(roomLinkInstances.id, instanceId));

    await tally.tallyDue(new Date(at(90).getTime() + TALLY_DELAY_MS));

    const got = await byUser(instanceId);
    expect(got.get(ada.userId)).toMatchObject({
      presentSeconds: 1800,
      status: AttendanceStatus.Partial,
    });
    expect(got.get(grace.userId)).toMatchObject({
      status: AttendanceStatus.Present,
      source: AttendanceSource.Override,
    });
  });

  it('voids a run cancelled afterwards, keeping corrections', async () => {
    await correct(grace.userId, AttendanceStatus.Present);
    await db
      .update(roomLinkInstances)
      .set({ cancelledAt: AFTER })
      .where(eq(roomLinkInstances.id, instanceId));

    await tally.tallyDue(new Date(AFTER.getTime() + MINUTE));

    expect(await rows(instanceId)).toEqual([
      expect.objectContaining({
        userId: grace.userId,
        source: AttendanceSource.Override,
      }),
    ]);
  });
});
