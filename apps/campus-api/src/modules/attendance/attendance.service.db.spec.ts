import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { auditLog, AuditAction } from '../audit/schema.js';
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
import { SystemRole, UserStatus, users } from '../users/schema.js';
import { AttendanceService, percentage } from './attendance.service.js';
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
const service = new AttendanceService(db as never);

const HOUR = 60 * 60_000;
const START = new Date(Date.now() - 5 * HOUR);
const audit = { actorUserId: null };
const page = { page: 1, perPage: 20 };

let cohortId: string;
let spaceId: string;
let trackA: string;
let trackB: string;
let podId: string;
let admin: AuthenticatedUser;
let professorA: AuthenticatedUser;
let professorB: AuthenticatedUser;
let mentor: AuthenticatedUser;
let ann: AuthenticatedUser;
let bob: AuthenticatedUser;
let wholeCohortClass: string;
let trackAClass: string;
let podClass: string;
let counter = 0;

async function person(
  name: string,
  systemRole = SystemRole.User,
): Promise<AuthenticatedUser> {
  const email = `${name}@campus.local`;
  const [row] = await db
    .insert(users)
    .values({ email, firstName: name, systemRole })
    .returning();
  return { id: row.id, email, systemRole };
}

async function member(
  user: AuthenticatedUser,
  role: CohortRole,
  values: Partial<typeof cohortMembers.$inferInsert> = {},
) {
  const [row] = await db
    .insert(cohortMembers)
    .values({
      cohortId,
      userId: user.id,
      role,
      ...(role === CohortRole.Student ? { status: StudentStatus.Active } : {}),
      ...values,
    })
    .returning();
  return row.id;
}

/** A tallied run, an hour long, `hoursAgo` before START, with these students' minutes. */
async function tallied(
  link: Partial<typeof roomLinks.$inferInsert>,
  minutes: Map<string, number>,
  hoursAgo = 0,
) {
  counter += 1;
  const [row] = await db
    .insert(roomLinks)
    .values({
      code: `code${counter}`.padEnd(10, 'x'),
      cohortId,
      spaceId,
      title: `Class ${counter}`,
      createdBy: admin.id,
      ...link,
    })
    .returning();
  const startsAt = new Date(START.getTime() - hoursAgo * HOUR);
  const endsAt = new Date(startsAt.getTime() + HOUR);
  const [instance] = await db
    .insert(roomLinkInstances)
    .values({
      roomLinkId: row.id,
      organizerId: admin.id,
      googleEventId: `event_${counter}`,
      startsAt,
      endsAt,
    })
    .returning();
  await db.insert(attendanceTallies).values({
    instanceId: instance.id,
    startsAt,
    endsAt,
    talliedAt: new Date(endsAt.getTime() + 5 * 60_000),
  });
  await db.insert(attendance).values(
    [...minutes].map(([userId, m]) => ({
      instanceId: instance.id,
      userId,
      presentSeconds: m * 60,
      status:
        m >= 45
          ? AttendanceStatus.Present
          : m > 0
            ? AttendanceStatus.Partial
            : AttendanceStatus.Absent,
    })),
  );
  return instance.id;
}

const rowOf = async (instanceId: string, userId: string) => {
  const [row] = await db
    .select()
    .from(attendance)
    .where(
      sql`${attendance.instanceId} = ${instanceId} and ${attendance.userId} = ${userId}`,
    );
  return row;
};

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(
    sql`truncate audit_log, attendance_overrides, attendance, attendance_tallies, room_link_instances, room_links, mentorship_group_students, mentorship_groups, cohort_members, cohort_tracks, tracks, spaces, maps, cohorts, users cascade`,
  );
  [{ id: cohortId }] = await db
    .insert(cohorts)
    .values({ name: 'C1', code: 'C1' })
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

  admin = await person('admin', SystemRole.Admin);
  professorA = await person('profa');
  professorB = await person('profb');
  mentor = await person('mentor');
  ann = await person('ann');
  bob = await person('bob');
  await member(professorA, CohortRole.Professor, { cohortTrackId: trackA });
  await member(professorB, CohortRole.Professor, { cohortTrackId: trackB });
  const mentorMember = await member(mentor, CohortRole.Mentor);
  const annMember = await member(ann, CohortRole.Student, {
    cohortTrackId: trackA,
  });
  await member(bob, CohortRole.Student, { cohortTrackId: trackB });
  [{ id: podId }] = await db
    .insert(mentorshipGroups)
    .values({ cohortId, mentorMemberId: mentorMember, name: 'Pod' })
    .returning();
  await db
    .insert(mentorshipGroupStudents)
    .values({ mentorshipGroupId: podId, cohortId, cohortMemberId: annMember });

  wholeCohortClass = await tallied(
    {},
    new Map([
      [ann.id, 60],
      [bob.id, 0],
    ]),
    2,
  );
  trackAClass = await tallied(
    {
      audience: RoomLinkAudience.CohortTrack,
      cohortTrackId: trackA,
    },
    new Map([[ann.id, 30]]),
    1,
  );
  podClass = await tallied(
    {
      audience: RoomLinkAudience.MentorshipGroup,
      mentorshipGroupId: podId,
    },
    new Map([[ann.id, 50]]),
  );
});

it('gives the percentage rounded down and capped', () => {
  expect(percentage(2699, 3600)).toBe(74);
  expect(percentage(2700, 3600)).toBe(75);
  expect(percentage(4000, 3600)).toBe(100);
  expect(percentage(0, 0)).toBe(0);
});

describe('listClasses', () => {
  it('gives admins every class, newest first, with counts', async () => {
    const result = await service.listClasses(admin, cohortId, page);
    expect(result.meta.total).toBe(3);
    expect(result.items.map((c) => c.instanceId)).toEqual([
      podClass,
      trackAClass,
      wholeCohortClass,
    ]);
    expect(result.items[2]).toMatchObject({
      audience: RoomLinkAudience.Cohort,
      expected: 2,
      present: 1,
      partial: 0,
      absent: 1,
      percentage: 50,
    });
  });

  it("gives a professor only their track's classes", async () => {
    const result = await service.listClasses(professorA, cohortId, page);
    expect(result.items.map((c) => c.instanceId)).toEqual([trackAClass]);
    expect(
      (await service.listClasses(professorB, cohortId, page)).items,
    ).toEqual([]);
  });

  it("gives a mentor only their pod's classes", async () => {
    const result = await service.listClasses(mentor, cohortId, page);
    expect(result.items.map((c) => c.instanceId)).toEqual([podClass]);
  });

  it('filters by start and pages', async () => {
    const result = await service.listClasses(admin, cohortId, {
      page: 2,
      perPage: 1,
      from: new Date(START.getTime() - 90 * 60_000),
    });
    expect(result.meta).toEqual({
      page: 2,
      perPage: 1,
      total: 2,
      totalPages: 2,
    });
    expect(result.items.map((c) => c.instanceId)).toEqual([trackAClass]);
  });

  it('refuses students, guests and staff whose place ended', async () => {
    await expect(service.listClasses(ann, cohortId, page)).rejects.toThrow(
      /read attendance/,
    );
    await db
      .update(cohortMembers)
      .set({ leftAt: new Date(Date.now() - 60_000) })
      .where(eq(cohortMembers.userId, professorA.id));
    await expect(
      service.listClasses(professorA, cohortId, page),
    ).rejects.toThrow(/read attendance/);
  });

  it('refuses a suspended admin and 404s an unknown cohort', async () => {
    await expect(
      service.listClasses(admin, randomUUID(), page),
    ).rejects.toThrow(/No cohort/);
    await db
      .update(users)
      .set({ status: UserStatus.Suspended })
      .where(eq(users.id, admin.id));
    await expect(service.listClasses(admin, cohortId, page)).rejects.toThrow(
      /may not read/,
    );
  });
});

describe('getClass', () => {
  it('lists every expected student with time and percentage', async () => {
    const result = await service.getClass(admin, wholeCohortClass);
    expect(result.students).toEqual([
      expect.objectContaining({
        userId: ann.id,
        firstName: 'ann',
        presentSeconds: 3600,
        percentage: 100,
        status: AttendanceStatus.Present,
        source: AttendanceSource.Derived,
      }),
      expect.objectContaining({
        userId: bob.id,
        percentage: 0,
        status: AttendanceStatus.Absent,
      }),
    ]);
  });

  it("keeps whole-cohort classes to admins and others' classes to their staff", async () => {
    await expect(
      service.getClass(professorA, wholeCohortClass),
    ).rejects.toThrow(/Whole-cohort classes are for admins/);
    await expect(service.getClass(mentor, trackAClass)).rejects.toThrow(
      /Whole-cohort/,
    );
    await expect(service.getClass(professorB, trackAClass)).rejects.toThrow(
      /Whole-cohort/,
    );
    const own = await service.getClass(professorA, trackAClass);
    expect(own.students[0]).toMatchObject({ percentage: 50 });
  });

  it('404s a run with no tally', async () => {
    await expect(service.getClass(admin, randomUUID())).rejects.toThrow(
      /No tallied class/,
    );
  });
});

describe('listStudents', () => {
  it('sums across the classes the caller may read', async () => {
    expect(await service.listStudents(admin, cohortId)).toEqual([
      expect.objectContaining({
        userId: ann.id,
        classes: 3,
        present: 2,
        partial: 1,
        absent: 0,
        percentage: 77,
      }),
      expect.objectContaining({
        userId: bob.id,
        classes: 1,
        absent: 1,
        percentage: 0,
      }),
    ]);
    expect(await service.listStudents(professorA, cohortId)).toEqual([
      expect.objectContaining({ userId: ann.id, classes: 1, partial: 1 }),
    ]);
    expect(await service.listStudents(professorB, cohortId)).toEqual([]);
  });
});

describe('getStudent', () => {
  it('lets a student read every class of their own', async () => {
    const result = await service.getStudent(ann, cohortId, ann.id);
    expect(result).toMatchObject({ classes: 3, present: 2, partial: 1 });
    expect(result.runs.map((r) => r.instanceId)).toEqual([
      podClass,
      trackAClass,
      wholeCohortClass,
    ]);
  });

  it("refuses a student another's attendance", async () => {
    await expect(service.getStudent(bob, cohortId, ann.id)).rejects.toThrow(
      /read attendance/,
    );
  });

  it('gives staff the classes they may read', async () => {
    const result = await service.getStudent(mentor, cohortId, ann.id);
    expect(result.runs.map((r) => r.instanceId)).toEqual([podClass]);
    expect(result.percentage).toBe(83);
  });
});

describe('correct', () => {
  const absent = {
    status: AttendanceStatus.Absent,
    reason: 'Left the laptop in the call',
  };

  it('sets the status, keeps the override and writes the audit entry', async () => {
    const row = await rowOf(trackAClass, ann.id);
    const result = await service.correct(professorA, row.id, absent, {
      actorUserId: professorA.id,
    });
    expect(result).toMatchObject({
      id: row.id,
      status: AttendanceStatus.Absent,
      source: AttendanceSource.Override,
      presentSeconds: 1800,
      percentage: 50,
    });
    expect(await db.select().from(attendanceOverrides)).toEqual([
      expect.objectContaining({
        attendanceId: row.id,
        changedBy: professorA.id,
        oldStatus: AttendanceStatus.Partial,
        newStatus: AttendanceStatus.Absent,
        reason: absent.reason,
      }),
    ]);
    const [entry] = await db.select().from(auditLog);
    expect(entry).toMatchObject({
      action: AuditAction.AttendanceCorrected,
      actorUserId: professorA.id,
      subjectId: row.id,
      spaceId,
      details: expect.objectContaining({
        studentUserId: ann.id,
        from: AttendanceStatus.Partial,
        to: AttendanceStatus.Absent,
      }),
    });
  });

  it('keeps every correction', async () => {
    const row = await rowOf(podClass, ann.id);
    await service.correct(mentor, row.id, absent, audit);
    await service.correct(
      mentor,
      row.id,
      { status: AttendanceStatus.Present, reason: 'Mixed up students' },
      audit,
    );
    const overrides = await db
      .select({
        oldStatus: attendanceOverrides.oldStatus,
        newStatus: attendanceOverrides.newStatus,
      })
      .from(attendanceOverrides)
      .orderBy(attendanceOverrides.createdAt);
    expect(overrides).toEqual([
      {
        oldStatus: AttendanceStatus.Present,
        newStatus: AttendanceStatus.Absent,
      },
      {
        oldStatus: AttendanceStatus.Absent,
        newStatus: AttendanceStatus.Present,
      },
    ]);
  });

  it('keeps whole-cohort classes to admins', async () => {
    const row = await rowOf(wholeCohortClass, ann.id);
    await expect(
      service.correct(professorA, row.id, absent, audit),
    ).rejects.toThrow(/Whole-cohort/);
    await expect(
      service.correct(mentor, row.id, absent, audit),
    ).rejects.toThrow(/Whole-cohort/);
    await service.correct(admin, row.id, absent, audit);
    expect((await rowOf(wholeCohortClass, ann.id)).status).toBe(
      AttendanceStatus.Absent,
    );
  });

  it("refuses staff of another track or pod's class", async () => {
    await expect(
      service.correct(
        professorB,
        (await rowOf(trackAClass, ann.id)).id,
        absent,
        audit,
      ),
    ).rejects.toThrow(/Whole-cohort/);
    await expect(
      service.correct(
        professorA,
        (await rowOf(podClass, ann.id)).id,
        absent,
        audit,
      ),
    ).rejects.toThrow(/Whole-cohort/);
    expect(await db.select().from(attendanceOverrides)).toEqual([]);
  });

  it('refuses the status it already has, a blank reason, and an unknown row', async () => {
    const row = await rowOf(podClass, ann.id);
    await expect(
      service.correct(
        mentor,
        row.id,
        { status: AttendanceStatus.Present, reason: 'Same' },
        audit,
      ),
    ).rejects.toThrow(/already present/);
    await expect(
      service.correct(mentor, row.id, { ...absent, reason: '  ' }, audit),
    ).rejects.toThrow(/needs a reason/);
    await expect(
      service.correct(mentor, randomUUID(), absent, audit),
    ).rejects.toThrow(/No attendance row/);
    expect(await db.select().from(auditLog)).toEqual([]);
  });
});
