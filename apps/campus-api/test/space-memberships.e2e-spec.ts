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
import { AuditAction, auditLog } from './../src/modules/audit/schema.js';
import { SESSION_COOKIE } from './../src/modules/auth/session-cookie.js';
import { cohortTracks, cohorts } from './../src/modules/cohorts/schema.js';
import {
  AudioMode,
  SpaceAccess,
  maps,
  spaceMemberships,
  spaces,
} from './../src/modules/maps/schema.js';
import { tracks } from './../src/modules/tracks/schema.js';
import { SystemRole, users } from './../src/modules/users/schema.js';
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
 * Granting, ending and reading access to a space, all the way: the routes,
 * the guards on them, the rows and the audit entries they leave. The
 * decisions are in the service's own tests; this file is about the wire —
 * who is turned away, what status each refusal is, and that the routes are
 * in the OpenAPI document every caller reads.
 */
describe('space memberships (e2e)', () => {
  let app: INestApplication<App>;
  let admin: typeof users.$inferSelect;
  let member: typeof users.$inferSelect;
  let adminCookie: string;
  let memberCookie: string;
  let spaceId: string;
  let retiredSpaceId: string;
  let cohortTrackId: string;

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

  const grant = (
    body: Record<string, unknown>,
    cookie = adminCookie,
    onSpace = spaceId,
  ) =>
    request(app.getHttpServer())
      .post(`/v1/spaces/${onSpace}/memberships`)
      .set('Cookie', cookie)
      .send(body);

  const list = (cookie = adminCookie, onSpace = spaceId) =>
    request(app.getHttpServer())
      .get(`/v1/spaces/${onSpace}/memberships`)
      .set('Cookie', cookie);

  const end = (membershipId: string, cookie = adminCookie, onSpace = spaceId) =>
    request(app.getHttpServer())
      .delete(`/v1/spaces/${onSpace}/memberships/${membershipId}`)
      .set('Cookie', cookie);

  /** The audit entries for one grant. */
  const entriesFor = (membershipId: string) =>
    db.select().from(auditLog).where(eq(auditLog.subjectId, membershipId));

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DRIZZLE)
      .useValue(db)
      // More requests than a route's allowance; nothing here tests limits.
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
    // Listening once, rather than app.init(): supertest otherwise opens and
    // closes a server on a new port for every request.
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate audit_log, space_memberships, spaces, maps, cohort_tracks, cohorts, tracks, users cascade`,
    );

    const [memberRow] = await db
      .insert(users)
      .values({ email: 'member@campus.local' })
      .returning();
    const [adminRow] = await db
      .insert(users)
      .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
      .returning();
    member = memberRow;
    admin = adminRow;
    adminCookie = await cookieFor(admin);
    memberCookie = await cookieFor(member);

    const [map] = await db
      .insert(maps)
      .values({ key: 'campus', name: 'Campus' })
      .returning();
    const [room] = await db
      .insert(spaces)
      .values({
        mapId: map.id,
        key: 'mentor-pod',
        name: 'Mentor Pod',
        access: SpaceAccess.Invite,
        audioMode: AudioMode.Proximity,
      })
      .returning();
    const [retired] = await db
      .insert(spaces)
      .values({
        mapId: map.id,
        key: 'old-pod',
        name: 'Old Pod',
        access: SpaceAccess.Invite,
        audioMode: AudioMode.Proximity,
        retiredAt: new Date('2026-01-01T00:00:00.000Z'),
      })
      .returning();
    spaceId = room.id;
    retiredSpaceId = retired.id;

    const [track] = await db
      .insert(tracks)
      .values({ name: 'Frontend', code: 'FE' })
      .returning();
    const [cohort] = await db
      .insert(cohorts)
      .values({ name: 'Cohort 1', code: 'C1' })
      .returning();
    const [run] = await db
      .insert(cohortTracks)
      .values({ cohortId: cohort.id, trackId: track.id })
      .returning();
    cohortTrackId = run.id;
  });

  it('refuses without a session, and refuses a member on every route', async () => {
    await request(app.getHttpServer())
      .post(`/v1/spaces/${spaceId}/memberships`)
      .expect(401);
    await request(app.getHttpServer())
      .get(`/v1/spaces/${spaceId}/memberships`)
      .expect(401);

    await grant({ userId: member.id }, memberCookie).expect(403);
    await list(memberCookie).expect(403);
    await end('55555555-5555-4555-8555-555555555555', memberCookie).expect(403);

    // Nothing was written past the guards.
    await expect(db.select().from(spaceMemberships)).resolves.toHaveLength(0);
  });

  it('grants one person access, answers with the grant, and audits it naming the admin', async () => {
    const res = await grant({ userId: member.id }).expect(201);

    expect(res.body).toMatchObject({
      spaceId,
      subject: {
        type: 'user',
        userId: member.id,
        email: 'member@campus.local',
      },
      grantedBy: admin.id,
      validTo: null,
      live: true,
    });
    expect(res.body.id).toEqual(expect.any(String));

    const [row] = await db
      .select()
      .from(spaceMemberships)
      .where(eq(spaceMemberships.id, res.body.id));
    expect(row).toMatchObject({
      spaceId,
      userId: member.id,
      grantedBy: admin.id,
    });

    const entries = await entriesFor(res.body.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorUserId: admin.id,
      action: AuditAction.SpaceMembershipGranted,
      spaceId,
    });
  });

  it('grants a cohort track, and the answer names the cohort that runs it', async () => {
    const res = await grant({ cohortTrackId }).expect(201);

    expect(res.body.subject).toMatchObject({
      type: 'cohort_track',
      cohortTrackId,
      trackName: 'Frontend',
      cohortName: 'Cohort 1',
    });
  });

  it('refuses a grant naming both subjects, or neither, as a field error', async () => {
    const both = await grant({ userId: member.id, cohortTrackId }).expect(400);
    expect(both.body).toMatchObject({
      error: { code: 'INVALID_ARGUMENT' },
    });

    await grant({}).expect(400);
    await expect(db.select().from(spaceMemberships)).resolves.toHaveLength(0);
  });

  it('refuses each way a grant can be wrong, with the status that says which', async () => {
    // No such space, no such person, no cohort running that track.
    await grant(
      { userId: member.id },
      adminCookie,
      '99999999-9999-4999-8999-999999999999',
    ).expect(404);
    await grant({ userId: '99999999-9999-4999-8999-999999999999' }).expect(404);
    await grant({
      cohortTrackId: '99999999-9999-4999-8999-999999999999',
    }).expect(404);
    // A retired space hands out nothing new.
    await grant({ userId: member.id }, adminCookie, retiredSpaceId).expect(409);
    // An end date that has passed would close before the grant opens.
    await grant({
      userId: member.id,
      validTo: '2020-01-01T00:00:00.000Z',
    }).expect(400);

    // A live grant already held by that subject.
    await grant({ userId: member.id }).expect(201);
    const again = await grant({ userId: member.id }).expect(409);
    expect(again.body.error.message).toMatch(/live grant/);

    // Only the one grant was written through all of it.
    await expect(db.select().from(spaceMemberships)).resolves.toHaveLength(1);
  });

  it('lists the space’s grants with who holds them now', async () => {
    await grant({ userId: member.id }).expect(201);
    await grant({ cohortTrackId }).expect(201);

    const res = await list().expect(200);

    expect(res.body).toHaveLength(2);
    expect(res.body.map((entry) => entry.subject.type)).toEqual([
      'user',
      'cohort_track',
    ]);
    expect(res.body.every((entry) => entry.live)).toBe(true);
  });

  it('ends a grant, keeps the row, audits it, and refuses a second end', async () => {
    const granted = await grant({ userId: member.id }).expect(201);

    await end(granted.body.id).expect(204);

    const [row] = await db
      .select()
      .from(spaceMemberships)
      .where(eq(spaceMemberships.id, granted.body.id));
    expect(row.validTo).not.toBeNull();
    const listed = await list().expect(200);
    expect(listed.body[0].live).toBe(false);

    const entries = await entriesFor(granted.body.id);
    expect(entries.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        AuditAction.SpaceMembershipGranted,
        AuditAction.SpaceMembershipEnded,
      ]),
    );

    await end(granted.body.id).expect(409);
    await end('55555555-5555-4555-8555-555555555555').expect(404);
  });

  it('is in the OpenAPI document, with the refusals documented on each route', () => {
    // Mirrors main.ts: the document every client is generated from.
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    );
    const paths = document.paths as Record<
      string,
      Record<string, { responses: Record<string, unknown> }>
    >;

    const many = paths['/v1/spaces/{id}/memberships'];
    expect(many.post.responses).toHaveProperty('201');
    expect(many.post.responses).toHaveProperty('403');
    expect(many.get.responses).toHaveProperty('200');
    expect(many.get.responses).toHaveProperty('403');

    const one = paths['/v1/spaces/{id}/memberships/{membershipId}'];
    expect(one.delete.responses).toHaveProperty('204');
    expect(one.delete.responses).toHaveProperty('403');

    // Admin-only, said by the security every operation carries.
    for (const operation of [many.post, many.get, one.delete]) {
      expect(JSON.stringify(operation)).toContain('bearer');
    }
  });
});
