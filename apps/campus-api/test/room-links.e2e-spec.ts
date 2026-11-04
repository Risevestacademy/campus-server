import { PGlite } from '@electric-sql/pglite';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SessionScope, signSessionToken } from '@campus/session';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ThrottlerStorage } from '@nestjs/throttler';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from './../src/app.module.js';
import { DRIZZLE } from './../src/infra/database/database.constants.js';
import * as schema from './../src/infra/database/schema/index.js';
import {
  AuditAction,
  AuditSubjectType,
  auditLog,
} from './../src/modules/audit/schema.js';
import { SESSION_COOKIE } from './../src/modules/auth/session-cookie.js';
import {
  CohortRole,
  cohortMembers,
  cohorts,
} from './../src/modules/cohorts/schema.js';
import {
  AudioMode,
  SpaceAccess,
  SpaceKind,
  maps,
  spaces,
} from './../src/modules/maps/schema.js';
import {
  roomLinkPasses,
  roomLinks,
} from './../src/modules/room-links/schema.js';
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
 * Room links over the wire: the status of each answer and refusal, what the
 * body carries, and the audit entry a request leaves. The rules themselves
 * are in the service's own tests.
 */
describe('room links (e2e)', () => {
  let app: INestApplication<App>;
  let cohortId: string;
  let spaceId: string;
  let mentorId: string;
  let mentorCookie: string;
  let guestCookie: string;
  let outsiderCookie: string;

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

  const linksPath = () => `/v1/cohorts/${cohortId}/spaces/${spaceId}/links`;

  const make = (title: unknown, cookie = mentorCookie) =>
    request(app.getHttpServer())
      .post(linksPath())
      .set('Cookie', cookie)
      .send({ title });

  const open = (code: string, cookie = guestCookie) =>
    request(app.getHttpServer())
      .get(`/v1/room-links/${code}`)
      .set('Cookie', cookie);

  const revoke = (code: string, cookie = mentorCookie) =>
    request(app.getHttpServer())
      .delete(`/v1/room-links/${code}`)
      .set('Cookie', cookie);

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
      sql`truncate audit_log, room_link_passes, room_links, spaces, maps, cohort_members, cohorts, users cascade`,
    );
    const [mentor, guest, outsider] = await db
      .insert(users)
      .values([
        { email: 'mentor@campus.local' },
        { email: 'guest@campus.local' },
        { email: 'outsider@campus.local' },
      ])
      .returning();
    const [cohort] = await db
      .insert(cohorts)
      .values({ name: 'Cohort 1', code: 'C1' })
      .returning();
    await db.insert(cohortMembers).values([
      { cohortId: cohort.id, userId: mentor.id, role: CohortRole.Mentor },
      {
        cohortId: cohort.id,
        userId: guest.id,
        role: CohortRole.Guest,
        accessExpiresAt: new Date(Date.now() + 86_400_000),
      },
    ]);
    const [map] = await db
      .insert(maps)
      .values({ key: 'campus', name: 'Campus', isEntry: true })
      .returning();
    const [pod] = await db
      .insert(spaces)
      .values({
        mapId: map.id,
        key: 'pod-a',
        name: 'Pod A',
        kind: SpaceKind.MeetingRoom,
        access: SpaceAccess.Normal,
        audioMode: AudioMode.Proximity,
      })
      .returning();
    cohortId = cohort.id;
    spaceId = pod.id;
    mentorId = mentor.id;
    mentorCookie = await cookieFor(mentor);
    guestCookie = await cookieFor(guest);
    outsiderCookie = await cookieFor(outsider);
  });

  it('makes a link staff can paste, which a member opens', async () => {
    const made = await make('  Design review  ')
      .set('x-correlation-id', '11111111-0000-4000-8000-00000000e2e1')
      .expect(201);

    expect(made.body).toMatchObject({
      title: 'Design review',
      cohortId,
      spaceId,
      spaceKey: 'pod-a',
      spaceName: 'Pod A',
    });
    expect(made.body.url).toBe(`http://localhost:3000/join/${made.body.code}`);

    const opened = await open(made.body.code).expect(200);
    expect(opened.body).toEqual(made.body);

    const [link] = await db
      .select({ id: roomLinks.id })
      .from(roomLinks)
      .where(eq(roomLinks.code, made.body.code));
    expect(await db.select().from(auditLog)).toEqual([
      expect.objectContaining({
        actorUserId: mentorId,
        action: AuditAction.RoomLinkCreated,
        subjectType: AuditSubjectType.RoomLink,
        subjectId: link.id,
        spaceId,
        correlationId: '11111111-0000-4000-8000-00000000e2e1',
      }),
    ]);
  });

  it('lists a space’s live links for staff', async () => {
    await make('Standup').expect(201);
    await make('Retro').expect(201);

    const listed = await request(app.getHttpServer())
      .get(linksPath())
      .set('Cookie', mentorCookie)
      .expect(200);

    expect(listed.body).toHaveLength(2);
  });

  it('revokes with a 204, after which the link is a 404', async () => {
    const { body } = await make('Office hours').expect(201);

    await revoke(body.code).expect(204);
    await revoke(body.code).expect(204);
    await open(body.code).expect(404);
  });

  it('turns away who may not, with the status for each', async () => {
    const { body } = await make('Class').expect(201);

    await request(app.getHttpServer())
      .get(`/v1/room-links/${body.code}`)
      .expect(401);
    await make('Mine', guestCookie).expect(403);
    await request(app.getHttpServer())
      .get(linksPath())
      .set('Cookie', guestCookie)
      .expect(403);
    await revoke(body.code, guestCookie).expect(403);
    await open(body.code, outsiderCookie).expect(404);
    await revoke(body.code, outsiderCookie).expect(404);
  });

  it('enters through a link while its window is open, with a pass world reads', async () => {
    const startsAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const endsAt = new Date(Date.now() + 65 * 60_000).toISOString();
    const { body } = await request(app.getHttpServer())
      .post(linksPath())
      .set('Cookie', mentorCookie)
      .send({ title: 'Class', startsAt, endsAt })
      .expect(201);
    expect(body).toMatchObject({ startsAt, endsAt });

    const entered = await request(app.getHttpServer())
      .post(`/v1/room-links/${body.code}/enter`)
      .set('Cookie', guestCookie)
      .expect(200);

    expect(entered.body).toMatchObject({
      code: body.code,
      spaceKey: 'pod-a',
      admitted: true,
    });
    expect(await db.select().from(roomLinkPasses)).toHaveLength(1);
    await request(app.getHttpServer())
      .post(`/v1/room-links/${body.code}/enter`)
      .set('Cookie', outsiderCookie)
      .expect(404);
  });

  it('lets staff set a window, and refuses a half or backwards one', async () => {
    const { body } = await make('Later').expect(201);
    const window = (cookie: string, times: object) =>
      request(app.getHttpServer())
        .put(`/v1/room-links/${body.code}/window`)
        .set('Cookie', cookie)
        .send(times);
    const startsAt = '2026-12-01T10:00:00.000Z';
    const endsAt = '2026-12-01T11:00:00.000Z';

    const set = await window(mentorCookie, { startsAt, endsAt }).expect(200);
    expect(set.body).toMatchObject({ startsAt, endsAt });
    await window(mentorCookie, {}).expect(200);
    await window(mentorCookie, { startsAt }).expect(400);
    await window(mentorCookie, { startsAt: null, endsAt }).expect(400);
    await window(mentorCookie, { startsAt: null, endsAt: null }).expect(400);
    await request(app.getHttpServer())
      .post(linksPath())
      .set('Cookie', mentorCookie)
      .send({ title: 'Null start', startsAt: null, endsAt })
      .expect(400);
    await window(mentorCookie, { startsAt: endsAt, endsAt: startsAt }).expect(
      400,
    );
    await window(mentorCookie, { startsAt: '2026-12-01T10:00', endsAt }).expect(
      400,
    );
    await window(guestCookie, { startsAt, endsAt }).expect(403);
  });

  it('refuses malformed requests with a 400', async () => {
    await make('   ').expect(400);
    await make('x'.repeat(129)).expect(400);
    await open('short').expect(400);
    await revoke('not-a-code!').expect(400);
    await request(app.getHttpServer())
      .post(`/v1/cohorts/not-a-uuid/spaces/${spaceId}/links`)
      .set('Cookie', mentorCookie)
      .send({ title: 'Class' })
      .expect(400);
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

    const many = paths['/v1/cohorts/{cohortId}/spaces/{spaceId}/links'];
    expect(Object.keys(many.post.responses)).toEqual(
      expect.arrayContaining(['201', '400', '401', '403', '404']),
    );
    expect(Object.keys(many.get.responses)).toEqual(
      expect.arrayContaining(['200', '400', '401', '403', '404']),
    );
    expect(JSON.stringify(many.post)).toContain('CreateRoomLinkDto');

    expect(
      Object.keys(paths['/v1/room-links/{code}/enter'].post.responses),
    ).toEqual(expect.arrayContaining(['200', '400', '401', '404']));
    expect(
      Object.keys(paths['/v1/room-links/{code}/window'].put.responses),
    ).toEqual(expect.arrayContaining(['200', '400', '401', '403', '404']));

    const one = paths['/v1/room-links/{code}'];
    expect(Object.keys(one.get.responses)).toEqual(
      expect.arrayContaining(['200', '400', '401', '404']),
    );
    expect(Object.keys(one.delete.responses)).toEqual(
      expect.arrayContaining(['204', '400', '401', '403', '404']),
    );

    for (const operation of [many.post, many.get, one.get, one.delete]) {
      expect(JSON.stringify(operation)).toContain('bearer');
    }
  });
});
