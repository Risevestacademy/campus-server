import { PGlite } from '@electric-sql/pglite';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { SessionScope, signSessionToken } from '@campus/session';
import { ThrottlerStorage } from '@nestjs/throttler';
import { and, eq, sql } from 'drizzle-orm';
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
  AudioMode,
  SpaceAccess,
  SpaceKind,
  maps,
  spaces,
} from './../src/modules/maps/schema.js';
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
const ORIGIN = 'http://localhost:3000';
const MISSING = '99999999-9999-4999-8999-999999999999';
const db = drizzle(new PGlite(), { schema });

/**
 * The admin routes that control what each space is and how it behaves, all
 * the way through the wire: the guards, the validation of allowed and
 * immutable fields, the database's own refusals, and the audit entry each
 * successful edit leaves.
 */
describe('space admin routes (e2e)', () => {
  let app: INestApplication<App>;
  let admin: typeof users.$inferSelect;
  let member: typeof users.$inferSelect;
  let adminCookie: string;
  let memberCookie: string;
  let mapId: string;
  let spaceId: string;
  let unsetId: string;
  let retiredId: string;

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

  const as = (cookie: string) => ({
    get: (path: string) =>
      request(app.getHttpServer()).get(path).set('Cookie', cookie),
    patch: (path: string, body: object) =>
      request(app.getHttpServer())
        .patch(path)
        .set('Cookie', cookie)
        .set('Origin', ORIGIN)
        .send(body),
  });

  const patch = (id: string, body: object, cookie = adminCookie) =>
    as(cookie).patch(`/v1/spaces/${id}`, body);

  const entryFor = (id: string) =>
    db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, AuditAction.SpaceUpdated),
          eq(auditLog.subjectId, id),
        ),
      );

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
      .values({ key: 'campus', name: 'Campus', isEntry: true })
      .returning();
    mapId = map.id;

    const [room] = await db
      .insert(spaces)
      .values({
        mapId,
        key: 'library',
        name: 'Library',
        kind: SpaceKind.Open,
        audioMode: AudioMode.Proximity,
        access: SpaceAccess.Normal,
      })
      .returning();
    const [unset] = await db
      .insert(spaces)
      .values({
        mapId,
        key: 'unset-room',
        name: 'Unset Room',
        kind: null,
        audioMode: AudioMode.Proximity,
        access: SpaceAccess.Normal,
      })
      .returning();
    const [retired] = await db
      .insert(spaces)
      .values({
        mapId,
        key: 'old-room',
        name: 'Old Room',
        kind: null,
        audioMode: AudioMode.Proximity,
        access: SpaceAccess.Normal,
        retiredAt: new Date('2026-01-01T00:00:00.000Z'),
      })
      .returning();

    spaceId = room.id;
    unsetId = unset.id;
    retiredId = retired.id;
  });

  describe('access', () => {
    it.each([
      ['get', '/v1/spaces'],
      ['get', `/v1/spaces/${MISSING}`],
      ['patch', `/v1/spaces/${MISSING}`],
    ] as const)('refuses %s %s without a session', async (method, path) => {
      await request(app.getHttpServer())[method](path).expect(401);
    });

    it.each([
      ['get', '/v1/spaces'],
      ['get', `/v1/spaces/${MISSING}`],
      ['patch', `/v1/spaces/${MISSING}`],
    ] as const)('refuses %s %s to a non-admin', async (method, path) => {
      const res =
        method === 'get'
          ? await as(memberCookie).get(path)
          : await as(memberCookie).patch(path, {});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('listing and reading', () => {
    it('lists live spaces by name and leaves retired ones out', async () => {
      const res = await as(adminCookie).get('/v1/spaces').expect(200);

      expect(res.body.items.map((row: { id: string }) => row.id)).toEqual([
        spaceId,
        unsetId,
      ]);
      expect(res.body.items.map((row: { id: string }) => row.id)).not.toContain(
        retiredId,
      );
      expect(res.body.meta).toEqual({
        page: 1,
        perPage: 20,
        total: 2,
        totalPages: 1,
      });
    });

    it('narrows the list to spaces with no kind', async () => {
      const res = await as(adminCookie)
        .get('/v1/spaces?needsKind=true')
        .expect(200);

      expect(res.body.items.map((row: { id: string }) => row.id)).toEqual([
        unsetId,
      ]);
      expect(res.body.meta.total).toBe(1);
    });

    it('reads one space, retired or not', async () => {
      const live = await as(adminCookie)
        .get(`/v1/spaces/${spaceId}`)
        .expect(200);
      expect(live.body).toMatchObject({
        id: spaceId,
        mapId,
        key: 'library',
        name: 'Library',
        kind: SpaceKind.Open,
        isMapDefault: false,
        access: SpaceAccess.Normal,
        audioMode: AudioMode.Proximity,
        capacity: null,
        audibleRadius: null,
        subscribeRadius: null,
        hysteresisFactor: '1.20',
        retiredAt: null,
      });

      const retired = await as(adminCookie)
        .get(`/v1/spaces/${retiredId}`)
        .expect(200);
      expect(retired.body.retiredAt).not.toBeNull();
    });

    it('answers 404 for a missing space and 400 for a bad id', async () => {
      const missing = await as(adminCookie)
        .get(`/v1/spaces/${MISSING}`)
        .expect(404);
      expect(missing.body.error).toMatchObject({
        code: 'NOT_FOUND',
        message: `Space ${MISSING} not found`,
      });

      await as(adminCookie).get('/v1/spaces/not-a-uuid').expect(400);
    });
  });

  describe('updating', () => {
    const ALLOWED = [
      ['name', 'Reading Room'],
      ['kind', SpaceKind.Classroom],
      ['access', SpaceAccess.Designated],
      ['audioMode', AudioMode.Boundary],
      ['capacity', 25],
      ['audibleRadius', 8.5],
      ['subscribeRadius', 10],
      ['hysteresisFactor', 1.5],
    ] as const;

    it.each(ALLOWED)(
      'writes %s and records the admin, the space and its old and new value',
      async (field, value) => {
        const before = await db.query.spaces.findFirst({
          where: eq(spaces.id, spaceId),
        });

        const res = await patch(spaceId, { [field]: value }).expect(200);

        const expected =
          field === 'audibleRadius' ||
          field === 'subscribeRadius' ||
          field === 'hysteresisFactor'
            ? Number(value).toFixed(2)
            : value;
        expect(res.body[field]).toEqual(expected);

        const entries = await entryFor(spaceId);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          actorUserId: admin.id,
          action: AuditAction.SpaceUpdated,
          subjectType: AuditSubjectType.Space,
          subjectId: spaceId,
          spaceId,
        });
        expect(entries[0].details).toEqual({
          changes: {
            [field]: { from: before?.[field], to: expected },
          },
        });
      },
    );

    it('returns the space and writes no entry when nothing moved', async () => {
      const empty = await patch(spaceId, {}).expect(200);
      expect(empty.body.id).toBe(spaceId);

      const same = await patch(spaceId, { name: 'Library' }).expect(200);
      expect(same.body.name).toBe('Library');

      expect(await entryFor(spaceId)).toHaveLength(0);
    });

    it.each([
      ['key', 'a-different-key'],
      ['mapId', MISSING],
      ['isMapDefault', true],
    ] as const)('refuses a change to %s, naming it', async (field, value) => {
      const res = await patch(spaceId, { [field]: value }).expect(400);

      expect(res.body.error).toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: 'Request validation failed',
        details: {
          fields: { [field]: `${field} cannot be changed` },
        },
      });
      expect(await entryFor(spaceId)).toHaveLength(0);

      const reread = await db.query.spaces.findFirst({
        where: eq(spaces.id, spaceId),
      });
      expect(reread?.key).toBe('library');
      expect(reread?.mapId).toBe(mapId);
      expect(reread?.isMapDefault).toBe(false);
    });

    it('refuses a default space that is not normal', async () => {
      const [grounds] = await db
        .insert(spaces)
        .values({
          mapId,
          key: 'grounds',
          name: 'Corridors and grounds',
          kind: SpaceKind.Open,
          isMapDefault: true,
          audioMode: AudioMode.Proximity,
          access: SpaceAccess.Normal,
        })
        .returning();

      const res = await patch(grounds.id, {
        access: SpaceAccess.Designated,
      }).expect(400);

      expect(res.body.error).toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: 'The default space must be open to everybody',
        details: {
          spaceId: grounds.id,
          fields: { access: 'The default space must be open to everybody' },
        },
      });
      expect(await entryFor(grounds.id)).toHaveLength(0);
    });

    it('refuses a capacity below 1', async () => {
      const res = await patch(spaceId, { capacity: 0 }).expect(400);

      expect(res.body.error).toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: 'Capacity must be at least 1',
        details: {
          spaceId,
          fields: { capacity: 'Capacity must be at least 1' },
        },
      });
      expect(await entryFor(spaceId)).toHaveLength(0);
    });

    it.each([
      [SpaceKind.TownHall, 'The campus already has a town hall'],
      [SpaceKind.NoticeBoard, 'The campus already has a notice board'],
    ] as const)('refuses a second %s', async (kind, message) => {
      await db.insert(spaces).values({
        mapId,
        key: `the-${kind}`,
        name: `The ${kind}`,
        kind,
        audioMode: AudioMode.Proximity,
        access: SpaceAccess.Normal,
      });

      const res = await patch(spaceId, { kind }).expect(409);

      expect(res.body.error).toMatchObject({
        code: 'CONFLICT',
        message,
        details: { spaceId, kind },
      });
      expect(await entryFor(spaceId)).toHaveLength(0);
    });

    it('refuses the removed broadcast audio mode as a field error', async () => {
      const res = await patch(spaceId, { audioMode: 'broadcast' }).expect(400);

      expect(res.body.error).toMatchObject({
        code: 'INVALID_ARGUMENT',
        details: { fields: { audioMode: expect.any(String) } },
      });
      expect(await entryFor(spaceId)).toHaveLength(0);
    });

    it('answers 404 for a missing space and 400 for a bad id', async () => {
      await patch(MISSING, { name: 'Nowhere' }).expect(404);
      await as(adminCookie).patch('/v1/spaces/not-a-uuid', {}).expect(400);
      expect(await entryFor(MISSING)).toHaveLength(0);
    });

    it('refuses an empty and a malformed name', async () => {
      const empty = await patch(spaceId, { name: '   ' }).expect(400);
      expect(empty.body.error.code).toBe('INVALID_ARGUMENT');

      const long = await patch(spaceId, { name: 'x'.repeat(129) }).expect(400);
      expect(long.body.error.code).toBe('INVALID_ARGUMENT');
      expect(await entryFor(spaceId)).toHaveLength(0);
    });
  });

  it('is in the OpenAPI document, with request and response schemas', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    );
    const paths = document.paths as Record<
      string,
      Record<string, { responses: Record<string, unknown> }>
    >;

    const many = paths['/v1/spaces'];
    expect(many.get.responses).toHaveProperty('200');
    expect(many.get.responses).toHaveProperty('400');
    expect(many.get.responses).toHaveProperty('403');

    const one = paths['/v1/spaces/{id}'];
    expect(one.get.responses).toHaveProperty('200');
    expect(one.get.responses).toHaveProperty('404');
    expect(one.patch.responses).toHaveProperty('200');
    expect(one.patch.responses).toHaveProperty('400');
    expect(one.patch.responses).toHaveProperty('403');
    expect(one.patch.responses).toHaveProperty('404');
    expect(one.patch.responses).toHaveProperty('409');
    // The body is a class, so it is both validated and described.
    expect(JSON.stringify(one.patch)).toContain('UpdateSpaceDto');
    expect(JSON.stringify(many.get)).toContain('SpaceResponseDto');
  });
});
