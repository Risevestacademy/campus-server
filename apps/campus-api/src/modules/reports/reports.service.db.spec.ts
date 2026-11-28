import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { AttendanceSource, AttendanceStatus } from '../attendance/schema.js';
import { attendance, attendanceTallies } from '../attendance/schema.js';
import { AuditAction, auditLog } from '../audit/schema.js';
import { CohortNotFoundException } from '../cohorts/cohorts.exceptions.js';
import {
  MembershipState,
  RosterScope,
} from '../cohorts/dto/cohort-roster.dto.js';
import {
  CohortRole,
  StudentStatus,
  cohortMembers,
  cohortTracks,
  cohorts,
} from '../cohorts/schema.js';
import { AudioMode, SpaceAccess, maps, spaces } from '../maps/schema.js';
import { roomLinkInstances, roomLinks } from '../room-links/schema.js';
import { tracks } from '../tracks/schema.js';
import { SystemRole, users } from '../users/schema.js';
import { InvalidArgumentException } from '../../shared/exceptions/access.exception.js';
import { ReportsService } from './reports.service.js';

/** Against a real engine: the live rule, the joins and the sums are SQL. */
const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);
const db = drizzle(new PGlite());
const service = new ReportsService(db as never);

const HOUR = 60 * 60_000;
const NOW = new Date('2026-11-22T12:00:00Z');
const all = { state: RosterScope.All };

let cohortId: string;
let otherCohortId: string;
let spaceId: string;
let backend: string;
let backendTrack: string;
let designTrack: string;
let admin: string;
let counter = 0;

async function person(
  firstName: string,
  lastName: string,
  systemRole = SystemRole.User,
) {
  const [row] = await db
    .insert(users)
    .values({
      email: `${firstName.toLowerCase()}@campus.local`,
      firstName,
      lastName,
      systemRole,
    })
    .returning();
  return row.id;
}

async function join(
  userId: string,
  role: CohortRole,
  values: Partial<typeof cohortMembers.$inferInsert> = {},
) {
  const [row] = await db
    .insert(cohortMembers)
    .values({
      cohortId,
      userId,
      role,
      ...(role === CohortRole.Student
        ? { status: StudentStatus.Active, cohortTrackId: backendTrack }
        : {}),
      ...(role === CohortRole.Guest
        ? { accessExpiresAt: new Date(NOW.getTime() + HOUR) }
        : {}),
      ...values,
    })
    .returning();
  return row.id;
}

/** A tallied hour-long class starting at `startsAt`, with each student's minutes. */
async function tallied(
  startsAt: Date,
  minutes: [string, number, AttendanceSource?][],
  forCohort = cohortId,
) {
  counter += 1;
  const [link] = await db
    .insert(roomLinks)
    .values({
      code: `code${counter}`.padEnd(10, 'x'),
      cohortId: forCohort,
      spaceId,
      title: `Class ${counter}`,
      createdBy: admin,
    })
    .returning();
  const endsAt = new Date(startsAt.getTime() + HOUR);
  const [instance] = await db
    .insert(roomLinkInstances)
    .values({
      roomLinkId: link.id,
      organizerId: admin,
      googleEventId: `event_${counter}`,
      startsAt,
      endsAt,
    })
    .returning();
  await db.insert(attendanceTallies).values({
    instanceId: instance.id,
    startsAt,
    endsAt,
    talliedAt: endsAt,
  });
  await db.insert(attendance).values(
    minutes.map(([userId, m, source]) => ({
      instanceId: instance.id,
      userId,
      presentSeconds: m * 60,
      status:
        m >= 45
          ? AttendanceStatus.Present
          : m > 0
            ? AttendanceStatus.Partial
            : AttendanceStatus.Absent,
      source: source ?? AttendanceSource.Derived,
    })),
  );
}

const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(
    sql`truncate audit_log, attendance_overrides, attendance, attendance_tallies, room_link_instances, room_links, cohort_members, cohort_tracks, tracks, spaces, maps, cohorts, users cascade`,
  );
  [{ id: cohortId }, { id: otherCohortId }] = await db
    .insert(cohorts)
    .values([
      { name: 'Cohort 1', code: 'C1' },
      { name: 'Cohort 2', code: 'C2' },
    ])
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
  const [be, de] = await db
    .insert(tracks)
    .values([
      { name: 'Backend', code: 'BE' },
      { name: 'Design', code: 'DE' },
    ])
    .returning();
  backend = be.id;
  [{ id: backendTrack }, { id: designTrack }] = await db
    .insert(cohortTracks)
    .values([
      { cohortId, trackId: be.id },
      { cohortId, trackId: de.id },
    ])
    .returning();
  admin = await person('Admin', 'Person', SystemRole.Admin);
});

describe('membership report', () => {
  it('lists every membership, staff then students then guests, by name, with how each ended', async () => {
    const prof = await person('Pat', 'Zed');
    const mentor = await person('Mo', 'Abel');
    const ann = await person('Ann', 'Bell');
    const cal = await person('Cal', 'Ash');
    const gus = await person('Gus', 'Guest');
    await join(prof, CohortRole.Professor);
    await join(mentor, CohortRole.Mentor);
    await join(ann, CohortRole.Student);
    await join(cal, CohortRole.Student, {
      status: StudentStatus.Dismissed,
      leftAt: at('2026-11-10T00:00:00Z'),
      dismissalReason: 'Missed every class',
    });
    await join(gus, CohortRole.Guest);

    const report = await service.membership(cohortId, all, NOW);

    expect(report.cohort).toEqual({
      id: cohortId,
      code: 'C1',
      name: 'Cohort 1',
    });
    expect(report.generatedAt).toEqual(NOW);
    expect(
      report.rows.map((r) => [r.lastName, r.role, r.state, r.endReason]),
    ).toEqual([
      ['Abel', CohortRole.Mentor, MembershipState.Live, null],
      ['Zed', CohortRole.Professor, MembershipState.Live, null],
      ['Ash', CohortRole.Student, MembershipState.Ended, 'Missed every class'],
      ['Bell', CohortRole.Student, MembershipState.Live, null],
      ['Guest', CohortRole.Guest, MembershipState.Live, null],
    ]);
    expect(report.rows[3]).toMatchObject({
      email: 'ann@campus.local',
      trackCode: 'BE',
      trackName: 'Backend',
      studentStatus: StudentStatus.Active,
      leftAt: null,
    });
  });

  it('filters by state, role and track as the roster does', async () => {
    const ann = await person('Ann', 'Bell');
    const dee = await person('Dee', 'Cole');
    const cal = await person('Cal', 'Ash');
    const prof = await person('Pat', 'Zed');
    await join(ann, CohortRole.Student);
    await join(dee, CohortRole.Student, { cohortTrackId: designTrack });
    await join(cal, CohortRole.Student, {
      status: StudentStatus.Withdrawn,
      leftAt: at('2026-11-10T00:00:00Z'),
    });
    await join(prof, CohortRole.Professor);

    const names = async (query: Parameters<typeof service.membership>[1]) =>
      (await service.membership(cohortId, query, NOW)).rows.map(
        (r) => r.firstName,
      );

    expect(await names({ state: RosterScope.Live })).toEqual([
      'Pat',
      'Ann',
      'Dee',
    ]);
    expect(await names({ state: RosterScope.Ended })).toEqual(['Cal']);
    expect(await names({ ...all, role: CohortRole.Professor })).toEqual([
      'Pat',
    ]);
    expect(await names({ ...all, trackId: backend })).toEqual(['Cal', 'Ann']);
  });

  it('calls a guest whose visit ran out ended, by the clock', async () => {
    const gus = await person('Gus', 'Guest');
    await join(gus, CohortRole.Guest, {
      accessExpiresAt: new Date(NOW.getTime() - 1),
    });
    const [row] = (await service.membership(cohortId, all, NOW)).rows;
    expect(row.state).toBe(MembershipState.Ended);
  });

  it('is a 404 for a cohort that does not exist', async () => {
    await expect(service.membership(randomUUID(), all, NOW)).rejects.toThrow(
      CohortNotFoundException,
    );
  });
});

describe('attendance report', () => {
  let ann: string;
  let bob: string;
  let dee: string;

  beforeEach(async () => {
    ann = await person('Ann', 'Bell');
    bob = await person('Bob', 'Cole');
    dee = await person('Dee', 'Dunn');
    await join(ann, CohortRole.Student);
    await join(bob, CohortRole.Student, { cohortTrackId: designTrack });
    await join(dee, CohortRole.Student);
  });

  it('sums each student over the classes, and keeps a student with none', async () => {
    await tallied(at('2026-11-02T10:00:00Z'), [
      [ann, 60],
      [bob, 30],
    ]);
    await tallied(at('2026-11-03T10:00:00Z'), [
      [ann, 0, AttendanceSource.Override],
      [bob, 45],
    ]);

    const report = await service.attendance(cohortId, all, NOW);

    expect(report.from).toBeNull();
    expect(report.to).toBeNull();
    expect(
      report.rows.map((r) => ({
        name: r.firstName,
        classes: r.classes,
        present: r.present,
        partial: r.partial,
        absent: r.absent,
        corrected: r.corrected,
        presentSeconds: r.presentSeconds,
        possibleSeconds: r.possibleSeconds,
        percentage: r.percentage,
      })),
    ).toEqual([
      {
        name: 'Ann',
        classes: 2,
        present: 1,
        partial: 0,
        absent: 1,
        corrected: 1,
        presentSeconds: 3600,
        possibleSeconds: 7200,
        percentage: 50,
      },
      {
        name: 'Bob',
        classes: 2,
        present: 1,
        partial: 1,
        absent: 0,
        corrected: 0,
        presentSeconds: 4500,
        possibleSeconds: 7200,
        percentage: 62,
      },
      {
        name: 'Dee',
        classes: 0,
        present: 0,
        partial: 0,
        absent: 0,
        corrected: 0,
        presentSeconds: 0,
        possibleSeconds: 0,
        percentage: null,
      },
    ]);
  });

  it('counts classes starting in [from, to) and none from another cohort', async () => {
    await tallied(at('2026-10-31T23:00:00Z'), [[ann, 60]]);
    await tallied(at('2026-11-01T00:00:00Z'), [[ann, 30]]);
    await tallied(at('2026-11-30T23:00:00Z'), [[ann, 60]]);
    await tallied(at('2026-12-01T00:00:00Z'), [[ann, 60]]);
    await tallied(at('2026-11-10T00:00:00Z'), [[ann, 60]], otherCohortId);

    const report = await service.attendance(
      cohortId,
      {
        ...all,
        from: at('2026-11-01T00:00:00Z'),
        to: at('2026-12-01T00:00:00Z'),
      },
      NOW,
    );
    const [row] = report.rows;
    expect(row).toMatchObject({ firstName: 'Ann', classes: 2, present: 1 });
    expect(row.presentSeconds).toBe(90 * 60);
  });

  it('filters by track and state', async () => {
    await db
      .update(cohortMembers)
      .set({
        status: StudentStatus.Withdrawn,
        leftAt: at('2026-11-10T00:00:00Z'),
      })
      .where(sql`${cohortMembers.userId} = ${dee}`);

    const names = async (query: Parameters<typeof service.attendance>[1]) =>
      (await service.attendance(cohortId, query, NOW)).rows.map(
        (r) => r.firstName,
      );
    expect(await names({ ...all, trackId: backend })).toEqual(['Ann', 'Dee']);
    expect(await names({ state: RosterScope.Live })).toEqual(['Ann', 'Bob']);
    expect(await names({ state: RosterScope.Ended })).toEqual(['Dee']);
  });

  it('keeps the classes of somebody no longer a student, and leaves out staff without any', async () => {
    const prof = await person('Pat', 'Zed');
    await join(prof, CohortRole.Professor);
    await tallied(at('2026-11-02T10:00:00Z'), [[bob, 60]]);
    await db
      .update(cohortMembers)
      .set({ role: CohortRole.Mentor, status: null, cohortTrackId: null })
      .where(sql`${cohortMembers.userId} = ${bob}`);

    const rows = (await service.attendance(cohortId, all, NOW)).rows;
    expect(rows.map((r) => [r.firstName, r.role, r.classes])).toEqual([
      ['Ann', CohortRole.Student, 0],
      ['Bob', CohortRole.Mentor, 1],
      ['Dee', CohortRole.Student, 0],
    ]);
  });

  it('refuses a range that ends before it starts', async () => {
    await expect(
      service.attendance(
        cohortId,
        {
          ...all,
          from: at('2026-11-02T00:00:00Z'),
          to: at('2026-11-01T00:00:00Z'),
        },
        NOW,
      ),
    ).rejects.toThrow(InvalidArgumentException);
  });
});

describe('CSV export', () => {
  it('writes the membership rows and records the export, not the rows', async () => {
    const ann = await person('Ann', 'Bell');
    await join(ann, CohortRole.Student);

    const csv = await service.membershipCsv(
      cohortId,
      { ...all, trackId: backend },
      { actorUserId: admin, correlationId: 'req-1' },
      NOW,
    );

    expect(csv.filename).toBe('C1-membership-2026-11-22.csv');
    const [header, record, end] = csv.body.replace(/^﻿/, '').split('\r\n');
    expect(header.split(',').slice(0, 4)).toEqual([
      'email',
      'first_name',
      'last_name',
      'display_name',
    ]);
    expect(
      record.startsWith(
        'ann@campus.local,Ann,Bell,,student,BE,Backend,active,live,',
      ),
    ).toBe(true);
    expect(end).toBe('');

    const entries = await db.select().from(auditLog);
    expect(entries).toEqual([
      expect.objectContaining({
        action: AuditAction.ReportExported,
        actorUserId: admin,
        subjectType: 'cohort',
        subjectId: cohortId,
        correlationId: 'req-1',
        details: {
          report: 'membership',
          state: RosterScope.All,
          trackId: backend,
          role: null,
          from: null,
          to: null,
          rows: 1,
        },
      }),
    ]);
  });

  it('writes the attendance rows with the range in the audit entry', async () => {
    const ann = await person('Ann', 'Bell');
    await join(ann, CohortRole.Student);
    await tallied(at('2026-11-02T10:00:00Z'), [[ann, 45]]);

    const csv = await service.attendanceCsv(
      cohortId,
      { ...all, from: at('2026-11-01T00:00:00Z') },
      { actorUserId: admin },
      NOW,
    );

    expect(csv.filename).toBe('C1-attendance-2026-11-22.csv');
    const [header, record] = csv.body.replace(/^﻿/, '').split('\r\n');
    const cells = Object.fromEntries(
      header.split(',').map((h, i) => [h, record.split(',')[i]]),
    );
    expect(cells).toMatchObject({
      classes: '1',
      present: '1',
      present_seconds: '2700',
      possible_seconds: '3600',
      percentage: '75',
    });
    const [entry] = await db.select().from(auditLog);
    expect(entry.details).toMatchObject({
      report: 'attendance',
      from: '2026-11-01T00:00:00.000Z',
      to: null,
      rows: 1,
    });
  });

  it('writes no audit entry for a JSON read', async () => {
    await service.membership(cohortId, all, NOW);
    await service.attendance(cohortId, all, NOW);
    expect(await db.select().from(auditLog)).toEqual([]);
  });
});
