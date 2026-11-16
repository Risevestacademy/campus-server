import { PGlite } from '@electric-sql/pglite';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SessionScope, signSessionToken } from '@campus/session';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ThrottlerStorage } from '@nestjs/throttler';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from './../src/app.module.js';
import { DRIZZLE } from './../src/infra/database/database.constants.js';
import * as schema from './../src/infra/database/schema/index.js';
import {
  AttendanceStatus,
  attendance,
  attendanceTallies,
} from './../src/modules/attendance/schema.js';
import { AuditAction, auditLog } from './../src/modules/audit/schema.js';
import { SESSION_COOKIE } from './../src/modules/auth/session-cookie.js';
import {
  CohortRole,
  StudentStatus,
  cohortMembers,
  cohortTracks,
  cohorts,
} from './../src/modules/cohorts/schema.js';
import {
  AudioMode,
  SpaceAccess,
  maps,
  spaces,
} from './../src/modules/maps/schema.js';
import {
  RoomLinkAudience,
  roomLinkInstances,
  roomLinks,
} from './../src/modules/room-links/schema.js';
import { tracks } from './../src/modules/tracks/schema.js';
import { users } from './../src/modules/users/schema.js';
import { ValidationException } from './../src/shared/exceptions/index.js';
import {
  DomainExceptionFilter,
  GlobalExceptionFilter,
  ValidationExceptionFilter,
} from './../src/shared/filters/index.js';

const MIGRATIONS = fileURLToPath(
  new URL('../src/infra/database/migrations', import.meta.url),
);
const SECRET = 'an-e2e-session-secret-of-at-least-32-chars';
const db = drizzle(new PGlite(), { schema });

/**
 * Attendance over the wire: routes, statuses and bodies. Who may read and
 * correct which class is in the service's own tests.
 */
describe('attendance (e2e)', () => {
  let app: INestApplication<App>;
  let cohortId: string;
  let studentId: string;
  let instanceId: string;
  let attendanceId: string;
  let professorCookie: string;
  let studentCookie: string;

  const cookieFor = async (user: { id: string; email: string }) => {
    const { token } = await signSessionToken(
      {
        epoch: 0,
        userId: user.id,
        email: user.email,
        scope: SessionScope.FullAccess,
      },
      { secret: SECRET, ttlMinutes: 15 },
    );
    return `${SESSION_COOKIE}=${token}`;
  };

  const get = (path: string, cookie = professorCookie) =>
    request(app.getHttpServer()).get(path).set('Cookie', cookie);

  const correct = (id: string, body: object, cookie = professorCookie) =>
    request(app.getHttpServer())
      .put(`/v1/attendance/${id}`)
      .set('Cookie', cookie)
      .send(body);

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DRIZZLE)
      .useValue(db)
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: async () => ({
          totalHits: 1,
          timeToExpire: 0,
          isBlocked: false,
          timeToBlockExpire: 0,
        }),
      })
      .compile();
    app = moduleFixture.createNestApplication({ logger: false });
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        exceptionFactory: (errors) => new ValidationException(errors),
      }),
    );
    app.useGlobalFilters(
      new GlobalExceptionFilter(),
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate audit_log, attendance_overrides, attendance, attendance_tallies, room_link_instances, room_links, spaces, maps, cohort_members, cohort_tracks, tracks, cohorts, users cascade`,
    );
    const [professor, student] = await db
      .insert(users)
      .values([
        { email: 'professor@campus.local' },
        { email: 'student@campus.local', firstName: 'Ann' },
      ])
      .returning();
    const [cohort] = await db
      .insert(cohorts)
      .values({ name: 'Cohort 1', code: 'C1' })
      .returning();
    const [track] = await db
      .insert(tracks)
      .values({ name: 'Backend', code: 'BE' })
      .returning();
    const [cohortTrack] = await db
      .insert(cohortTracks)
      .values({ cohortId: cohort.id, trackId: track.id })
      .returning();
    await db.insert(cohortMembers).values([
      {
        cohortId: cohort.id,
        userId: professor.id,
        role: CohortRole.Professor,
        cohortTrackId: cohortTrack.id,
      },
      {
        cohortId: cohort.id,
        userId: student.id,
        role: CohortRole.Student,
        cohortTrackId: cohortTrack.id,
        status: StudentStatus.Active,
      },
    ]);
    const [map] = await db
      .insert(maps)
      .values({ key: 'campus', name: 'Campus', isEntry: true })
      .returning();
    const [space] = await db
      .insert(spaces)
      .values({
        mapId: map.id,
        key: 'lecture',
        name: 'Lecture',
        access: SpaceAccess.Normal,
        audioMode: AudioMode.Boundary,
      })
      .returning();
    const [link] = await db
      .insert(roomLinks)
      .values({
        code: 'k3F9xQ2pLm',
        cohortId: cohort.id,
        spaceId: space.id,
        title: 'Backend class',
        createdBy: professor.id,
        audience: RoomLinkAudience.CohortTrack,
        cohortTrackId: cohortTrack.id,
      })
      .returning();
    const startsAt = new Date(Date.now() - 3 * 3_600_000);
    const endsAt = new Date(startsAt.getTime() + 3_600_000);
    const [instance] = await db
      .insert(roomLinkInstances)
      .values({
        roomLinkId: link.id,
        organizerId: professor.id,
        googleEventId: 'event_1',
        startsAt,
        endsAt,
      })
      .returning();
    await db
      .insert(attendanceTallies)
      .values({ instanceId: instance.id, startsAt, endsAt, talliedAt: endsAt });
    const [row] = await db
      .insert(attendance)
      .values({
        instanceId: instance.id,
        userId: student.id,
        presentSeconds: 1800,
        status: AttendanceStatus.Partial,
      })
      .returning();

    cohortId = cohort.id;
    studentId = student.id;
    instanceId = instance.id;
    attendanceId = row.id;
    professorCookie = await cookieFor(professor);
    studentCookie = await cookieFor(student);
  });

  it('lists classes, a class, students and a student', async () => {
    const classes = await get(
      `/v1/cohorts/${cohortId}/attendance/classes?perPage=5`,
    ).expect(200);
    expect(classes.body).toMatchObject({
      items: [
        { instanceId, title: 'Backend class', partial: 1, percentage: 50 },
      ],
      meta: { page: 1, perPage: 5, total: 1, totalPages: 1 },
    });

    const one = await get(`/v1/attendance/classes/${instanceId}`).expect(200);
    expect(one.body.students).toEqual([
      expect.objectContaining({
        id: attendanceId,
        firstName: 'Ann',
        presentSeconds: 1800,
        percentage: 50,
        status: 'partial',
        source: 'derived',
      }),
    ]);

    const students = await get(
      `/v1/cohorts/${cohortId}/attendance/students`,
    ).expect(200);
    expect(students.body).toEqual([
      expect.objectContaining({
        userId: studentId,
        classes: 1,
        percentage: 50,
      }),
    ]);

    const own = await get(
      `/v1/cohorts/${cohortId}/attendance/students/${studentId}`,
      studentCookie,
    ).expect(200);
    expect(own.body).toMatchObject({
      userId: studentId,
      classes: 1,
      runs: [{ instanceId, title: 'Backend class', status: 'partial' }],
    });
  });

  it('keeps staff reads from students', async () => {
    await get(
      `/v1/cohorts/${cohortId}/attendance/classes`,
      studentCookie,
    ).expect(403);
    await get(`/v1/attendance/classes/${instanceId}`, studentCookie).expect(
      403,
    );
    await request(app.getHttpServer())
      .get(`/v1/cohorts/${cohortId}/attendance/students`)
      .expect(401);
  });

  it('corrects a status with a reason and records it', async () => {
    const corrected = await correct(attendanceId, {
      status: 'present',
      reason: '  On the mobile app  ',
    })
      .set('x-correlation-id', '11111111-0000-4000-8000-00000000a771')
      .expect(200);
    expect(corrected.body).toMatchObject({
      id: attendanceId,
      status: 'present',
      source: 'override',
      percentage: 50,
    });

    const [entry] = await db.select().from(auditLog);
    expect(entry).toMatchObject({
      action: AuditAction.AttendanceCorrected,
      correlationId: '11111111-0000-4000-8000-00000000a771',
      details: expect.objectContaining({ reason: 'On the mobile app' }),
    });

    await correct(
      attendanceId,
      { status: 'absent', reason: 'Mine' },
      studentCookie,
    ).expect(403);
  });

  it('refuses malformed corrections', async () => {
    await correct(attendanceId, { status: 'late', reason: 'x' }).expect(400);
    await correct(attendanceId, { status: 'present' }).expect(400);
    await correct(attendanceId, { status: 'present', reason: '   ' }).expect(
      400,
    );
    await correct(attendanceId, {
      status: 'present',
      reason: 'x'.repeat(501),
    }).expect(400);
    await correct(attendanceId, { status: 'partial', reason: 'Same' }).expect(
      400,
    );
    await correct('not-a-uuid', { status: 'present', reason: 'x' }).expect(400);
    await correct('77777777-7777-4777-8777-777777777777', {
      status: 'present',
      reason: 'x',
    }).expect(404);
    await get(
      `/v1/cohorts/${cohortId}/attendance/classes?from=yesterday`,
    ).expect(400);
  });

  it('is in the OpenAPI document, with the refusals documented on each route', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    );
    const paths = document.paths as Record<
      string,
      Record<string, { responses: Record<string, unknown> }>
    >;
    const routes = [
      paths['/v1/cohorts/{cohortId}/attendance/classes'].get,
      paths['/v1/cohorts/{cohortId}/attendance/students'].get,
      paths['/v1/cohorts/{cohortId}/attendance/students/{userId}'].get,
      paths['/v1/attendance/classes/{instanceId}'].get,
      paths['/v1/attendance/{attendanceId}'].put,
    ];
    for (const route of routes) {
      expect(Object.keys(route.responses)).toEqual(
        expect.arrayContaining(['200', '400', '401', '403', '404']),
      );
      expect(JSON.stringify(route)).toContain('bearer');
    }
    expect(JSON.stringify(routes[4])).toContain('CorrectAttendanceDto');
  });
});
