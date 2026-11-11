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
  FIRST_RETRY_MS,
  TALLY_DELAY_MS,
  attendanceStatus,
  coveredMs,
} from './attendance-tally.service.js';
import {
  AttendanceSource,
  AttendanceStatus,
  attendance,
  attendanceOverrides,
  attendanceTallies,
  attendanceTallyFailures,
} from './schema.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);
const db = drizzle(new PGlite());
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setContext: vi.fn(),
};
const tally = new AttendanceTallyService(
  db as never,
  { register: vi.fn() } as unknown as Scheduler,
  logger as unknown as PinoLogger,
);

const MINUTE = 60_000;
const START = new Date(
  Math.floor(Date.now() / MINUTE) * MINUTE - 3 * 60 * MINUTE,
);
const END = new Date(START.getTime() + 60 * MINUTE);
const at = (minutes: number) => new Date(START.getTime() + minutes * MINUTE);
/** Tallies happen now, after every row a test writes, as they would. */
const tallyNow = () => tally.tallyDue(new Date());

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
    sql`truncate attendance_overrides, attendance, attendance_tally_failures, attendance_tallies, room_link_instances, room_links, session_participants, sessions, mentorship_group_students, mentorship_groups, cohort_members, cohort_tracks, tracks, spaces, maps, cohorts, users cascade`,
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

it('counts overlapping and touching stretches once', () => {
  const t = (m: number) => new Date(m * MINUTE);
  expect(
    coveredMs([
      { from: t(10), to: t(40) },
      { from: t(0), to: t(30) },
      { from: t(40), to: t(45) },
      { from: t(50), to: t(50) },
      { from: t(55), to: t(60) },
    ]),
  ).toBe(50 * MINUTE);
  expect(coveredMs([])).toBe(0);
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

    await tallyNow();

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
    expect(kept).toMatchObject({ instanceId, startsAt: START, endsAt: END });
  });

  it('waits until a few minutes after the run ends, for late word of who left', async () => {
    await student('ada');
    const endedJustNow = new Date(Date.now() - TALLY_DELAY_MS + MINUTE);
    await run(
      {},
      {
        startsAt: new Date(endedJustNow.getTime() - 60 * MINUTE),
        endsAt: endedJustNow,
      },
    );

    await tallyNow();

    expect(await db.select().from(attendanceTallies)).toEqual([]);
  });

  it('counts somebody still in the call when it was tallied, up to the end', async () => {
    const ada = await student('ada');
    const instanceId = await run();
    await inCall(ada.userId, 15, null);

    await tallyNow();

    expect((await byUser(instanceId)).get(ada.userId)?.presentSeconds).toBe(
      45 * 60,
    );
  });

  it('counts overlapping stretches once', async () => {
    const ada = await student('ada');
    const grace = await student('grace');
    const instanceId = await run();
    await inCall(ada.userId, 0, 30);
    await inCall(ada.userId, 10, 40);
    await inCall(grace.userId, 0, 60);
    await inCall(grace.userId, 59, 60);

    await tallyNow();

    const got = await byUser(instanceId);
    expect(got.get(ada.userId)).toMatchObject({
      presentSeconds: 2400,
      status: AttendanceStatus.Partial,
    });
    expect(got.get(grace.userId)?.presentSeconds).toBe(3600);
  });

  it('counts only this cohort’s call in this space', async () => {
    const ada = await student('ada');
    const instanceId = await run();
    await inCall(ada.userId, 0, 60, { space: otherSpaceId });
    await inCall(ada.userId, 0, 60, { cohort: otherCohortId });

    await tallyNow();

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

    await tallyNow();

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

    await tallyNow();

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

    await tallyNow();

    expect([...(await byUser(instanceId)).keys()]).toEqual([ada.userId]);
  });

  it('tallies a run cancelled after it ended but before its first tally', async () => {
    const ada = await student('ada');
    const instanceId = await run();
    await inCall(ada.userId, 0, 60);
    await db
      .update(roomLinkInstances)
      .set({ cancelledAt: at(62) })
      .where(eq(roomLinkInstances.id, instanceId));

    await tallyNow();

    expect((await byUser(instanceId)).get(ada.userId)?.status).toBe(
      AttendanceStatus.Present,
    );
  });

  it('leaves out a call row open since long before the run, but not one opened during it', async () => {
    const ada = await student('ada');
    const grace = await student('grace');
    const instanceId = await run();
    await inCall(ada.userId, -13 * 60, null);
    const [stuck] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.spaceId, spaceId));
    await db.insert(sessionParticipants).values({
      sessionId: stuck.id,
      userId: grace.userId,
      providerIdentity: `${grace.userId}:late`,
      joinedAt: at(30),
    });

    await tallyNow();

    const got = await byUser(instanceId);
    expect(got.get(ada.userId)?.presentSeconds).toBe(0);
    expect(got.get(grace.userId)?.presentSeconds).toBe(30 * 60);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('tallies a run once, and leaves runs cancelled before they ended alone', async () => {
    await student('ada');
    const instanceId = await run();
    const cancelled = await run();
    await db
      .update(roomLinkInstances)
      .set({ cancelledAt: at(-60) })
      .where(eq(roomLinkInstances.id, cancelled));

    await tallyNow();
    const [first] = await db.select().from(attendanceTallies);
    await tallyNow();

    const tallies = await db.select().from(attendanceTallies);
    expect(tallies).toEqual([first]);
    expect(first.instanceId).toBe(instanceId);
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
    await tallyNow();
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

    await tallyNow();

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

  it('tallies a run again when Google restores it after a cancellation', async () => {
    await db
      .update(roomLinkInstances)
      .set({ cancelledAt: at(30) })
      .where(eq(roomLinkInstances.id, instanceId));
    await tallyNow();
    expect(await rows(instanceId)).toEqual([]);

    await db
      .update(roomLinkInstances)
      .set({ cancelledAt: null })
      .where(eq(roomLinkInstances.id, instanceId));
    await tallyNow();

    expect((await byUser(instanceId)).get(ada.userId)).toMatchObject({
      presentSeconds: 3600,
      status: AttendanceStatus.Present,
    });
  });

  it('tallies a run again when its event moves to another link', async () => {
    const elsewhere = await run({ spaceId: otherSpaceId });
    const [moved] = await db
      .select({ roomLinkId: roomLinkInstances.roomLinkId })
      .from(roomLinkInstances)
      .where(eq(roomLinkInstances.id, elsewhere));
    await db
      .update(roomLinkInstances)
      .set({ roomLinkId: moved.roomLinkId })
      .where(eq(roomLinkInstances.id, instanceId));

    await tallyNow();

    expect((await byUser(instanceId)).get(ada.userId)).toMatchObject({
      presentSeconds: 0,
      status: AttendanceStatus.Absent,
    });
  });

  it('keeps who it expected when the link’s pod is gone before a re-tally', async () => {
    const [mentor] = await db
      .select({ id: cohortMembers.id })
      .from(cohortMembers)
      .where(eq(cohortMembers.userId, mentorId));
    const [pod] = await db
      .insert(mentorshipGroups)
      .values({ cohortId, mentorMemberId: mentor.id, name: 'Pod B' })
      .returning();
    await db.insert(mentorshipGroupStudents).values({
      mentorshipGroupId: pod.id,
      cohortId,
      cohortMemberId: ada.memberId,
    });
    const podRun = await run({
      audience: RoomLinkAudience.MentorshipGroup,
      mentorshipGroupId: pod.id,
    });
    await tallyNow();
    expect([...(await byUser(podRun)).keys()]).toEqual([ada.userId]);

    const [{ roomLinkId }] = await db
      .select({ roomLinkId: roomLinkInstances.roomLinkId })
      .from(roomLinkInstances)
      .where(eq(roomLinkInstances.id, podRun));
    await db
      .update(roomLinks)
      .set({ revokedAt: new Date(), mentorshipGroupId: null })
      .where(eq(roomLinks.id, roomLinkId));
    await db
      .update(roomLinkInstances)
      .set({ startsAt: at(10), endsAt: at(70) })
      .where(eq(roomLinkInstances.id, podRun));

    await tallyNow();

    expect((await byUser(podRun)).get(ada.userId)).toMatchObject({
      presentSeconds: 50 * 60,
      status: AttendanceStatus.Present,
    });
  });

  it('voids a run cancelled before it ended, keeping corrections', async () => {
    await correct(grace.userId, AttendanceStatus.Present);
    await db
      .update(roomLinkInstances)
      .set({ cancelledAt: at(30) })
      .where(eq(roomLinkInstances.id, instanceId));

    await tallyNow();

    expect(await rows(instanceId)).toEqual([
      expect.objectContaining({
        userId: grace.userId,
        source: AttendanceSource.Override,
      }),
    ]);
  });

  it('keeps the attendance of a run cancelled after it ended, which took place', async () => {
    const before = await rows(instanceId);
    await db
      .update(roomLinkInstances)
      .set({ cancelledAt: new Date() })
      .where(eq(roomLinkInstances.id, instanceId));

    await tallyNow();

    expect(await rows(instanceId)).toEqual(before);
  });

  it('never deletes a row a correction was written for, whatever its source', async () => {
    const [row] = await db
      .select()
      .from(attendance)
      .where(eq(attendance.userId, grace.userId));
    await db.insert(attendanceOverrides).values({
      attendanceId: row.id,
      changedBy: mentorId,
      oldStatus: row.status,
      newStatus: row.status,
      reason: 'Checked, and right',
    });
    await db
      .update(roomLinkInstances)
      .set({ cancelledAt: at(30) })
      .where(eq(roomLinkInstances.id, instanceId));

    await tallyNow();

    expect((await rows(instanceId)).map((r) => r.userId)).toEqual([
      grace.userId,
    ]);
  });
});

describe('failures', () => {
  it('records a run whose tally fails, and tries it again later and later', async () => {
    await student('ada');
    const instanceId = await run();
    const failing = vi
      .spyOn(tally as unknown as { tally: () => Promise<void> }, 'tally')
      .mockRejectedValue(new Error('boom'));

    await tally.tallyDue(new Date());
    await tally.tallyDue(new Date());
    const [first] = await db.select().from(attendanceTallyFailures);
    expect(first).toMatchObject({ instanceId, attempts: 1 });
    expect(failing).toHaveBeenCalledTimes(1);

    await tally.tallyDue(
      new Date(first.lastFailedAt.getTime() + FIRST_RETRY_MS),
    );
    const [second] = await db.select().from(attendanceTallyFailures);
    expect(second.attempts).toBe(2);

    await tally.tallyDue(
      new Date(second.lastFailedAt.getTime() + FIRST_RETRY_MS),
    );
    expect(failing).toHaveBeenCalledTimes(2);

    failing.mockRestore();
    await tally.tallyDue(
      new Date(second.lastFailedAt.getTime() + 2 * FIRST_RETRY_MS),
    );
    expect(await db.select().from(attendanceTallyFailures)).toEqual([]);
    expect(await db.select().from(attendanceTallies)).toHaveLength(1);
  });

  it('tries runs that never failed before ones that keep failing', async () => {
    await student('ada');
    const failingRun = await run({}, { startsAt: at(-120), endsAt: at(-60) });
    const fresh = await run();
    await db.insert(attendanceTallyFailures).values({
      instanceId: failingRun,
      attempts: 1,
      lastFailedAt: new Date(Date.now() - 60 * MINUTE),
    });
    const order: string[] = [];
    const spy = vi
      .spyOn(
        tally as unknown as {
          tally: (r: { instanceId: string }) => Promise<void>;
        },
        'tally',
      )
      .mockImplementation(async (r) => {
        order.push(r.instanceId);
      });

    await tallyNow();

    expect(order).toEqual([fresh, failingRun]);
    spy.mockRestore();
  });
});
