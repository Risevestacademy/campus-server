import { PGlite } from '@electric-sql/pglite';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { SessionScope, signSessionToken } from '@campus/session';
import { asc, sql } from 'drizzle-orm';
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
import { MAPS_FETCH } from './../src/modules/maps/published-maps.js';
import { maps, spaces } from './../src/modules/maps/schema.js';
import { SystemRole, users } from './../src/modules/users/schema.js';
import { ValidationException } from './../src/shared/exceptions/index.js';
import {
  DomainExceptionFilter,
  GlobalExceptionFilter,
  ValidationExceptionFilter,
} from './../src/shared/filters/index.js';
import { fakeSanity, tiledMap } from './support/published-maps.js';

const MIGRATIONS = fileURLToPath(
  new URL('../src/infra/database/migrations', import.meta.url),
);
const SECRET = 'an-e2e-session-secret-of-at-least-32-chars';
const db = drizzle(new PGlite(), { schema });

/**
 * The route allows ten calls a minute, and this file makes more than that.
 * Everything but the one test of the limit runs with it lifted.
 */
const unlimited = {
  increment: async () => ({
    totalHits: 1,
    timeToExpire: 0,
    isBlocked: false,
    timeToBlockExpire: 0,
  }),
};

/** What "Sanity" answers with for the test that is running. */
let sanity: typeof fetch = fakeSanity({}).fetch;

/**
 * The sync route around the service: who may call it, and that a request
 * goes all the way through — the real package reading what "Sanity" holds,
 * the rows written, the answer saying what was done.
 */
describe('POST /v1/maps/sync (e2e)', () => {
  let app: INestApplication<App>;
  let admin: typeof users.$inferSelect;
  let adminCookie: string;
  let memberCookie: string;

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

  const sync = (query = '', cookie = adminCookie) =>
    request(app.getHttpServer())
      .post(`/v1/maps/sync${query}`)
      .set('Cookie', cookie);

  const publish = (
    campus: Parameters<typeof tiledMap>[0],
    version = 'campus-v1',
  ) => {
    sanity = fakeSanity(
      { campus: tiledMap(campus) },
      { campus: version },
    ).fetch;
  };

  const rows = async () => ({
    maps: await db
      .select({ key: maps.key, isEntry: maps.isEntry })
      .from(maps)
      .orderBy(asc(maps.key)),
    spaces: (
      await db
        .select({
          key: spaces.key,
          kind: spaces.kind,
          retired: spaces.retiredAt,
        })
        .from(spaces)
        .orderBy(asc(spaces.key))
    ).map((row) => `${row.key}[${row.kind ?? ''}]${row.retired ? '†' : ''}`),
  });

  async function boot(limited: boolean): Promise<INestApplication<App>> {
    let builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DRIZZLE)
      .useValue(db)
      .overrideProvider(MAPS_FETCH)
      // Looked up on each call, so a test can change what is published.
      .useValue(((input, init) => sanity(input, init)) as typeof fetch);
    if (!limited) {
      builder = builder.overrideProvider(ThrottlerStorage).useValue(unlimited);
    }
    const booted: INestApplication<App> = (
      await builder.compile()
    ).createNestApplication();
    booted.setGlobalPrefix('v1');
    booted.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        exceptionFactory: (errors) => new ValidationException(errors),
      }),
    );
    booted.useGlobalFilters(
      new GlobalExceptionFilter(),
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    // Listening once, rather than app.init(): supertest otherwise opens and
    // closes a server on a new port for every request.
    await booted.listen(0);
    return booted;
  }

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    app = await boot(false);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate audit_log, spaces, maps, users cascade`);
    const [member] = await db
      .insert(users)
      .values({ email: 'member@campus.local' })
      .returning();
    [admin] = await db
      .insert(users)
      .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
      .returning();
    adminCookie = await cookieFor(admin);
    memberCookie = await cookieFor(member);
    publish({
      spaces: [
        { key: 'library', name: 'The Library', class: 'open' },
        { key: 'room_1', class: 'meeting_room' },
        { key: 'nook' },
      ],
    });
  });

  it('refuses without a session, and refuses a member', async () => {
    await request(app.getHttpServer()).post('/v1/maps/sync').expect(401);
    await sync('', memberCookie).expect(403);
    await sync('?dryRun=true', memberCookie).expect(403);

    await expect(rows()).resolves.toEqual({ maps: [], spaces: [] });
  });

  it('adopts what is published, and says what it did', async () => {
    const res = await sync().expect(200);

    expect(res.body).toEqual({
      dryRun: false,
      changed: true,
      maps: [
        {
          key: 'campus',
          version: 'campus-v1',
          isEntry: true,
          outcome: 'created',
          spaces: {
            added: [
              { key: 'library', name: 'The Library', kind: 'open' },
              { key: 'room_1', name: 'room_1', kind: 'meeting_room' },
              { key: 'nook', name: 'nook', kind: null },
            ],
            restored: [],
            retired: [],
            needsKind: ['nook'],
          },
        },
      ],
    });
    await expect(rows()).resolves.toEqual({
      maps: [{ key: 'campus', isEntry: true }],
      spaces: [
        '_default[open]',
        'library[open]',
        'nook[]',
        'room_1[meeting_room]',
      ],
    });
    const [entry] = await db.select().from(auditLog);
    expect(entry).toMatchObject({
      action: AuditAction.MapSynced,
      actorUserId: admin.id,
    });
  });

  it('changes nothing the second time, and after a publish retires and adds', async () => {
    await sync().expect(200);

    const again = await sync().expect(200);
    expect(again.body.changed).toBe(false);

    publish(
      { spaces: [{ key: 'library', class: 'open' }, { key: 'lab' }] },
      'campus-v2',
    );
    const after = await sync().expect(200);

    expect(after.body.maps[0]).toMatchObject({
      version: 'campus-v2',
      outcome: 'updated',
      spaces: {
        added: [{ key: 'lab', name: 'lab', kind: null }],
        retired: ['nook', 'room_1'],
        needsKind: ['lab'],
      },
    });
    await expect(rows()).resolves.toMatchObject({
      spaces: [
        '_default[open]',
        'lab[]',
        'library[open]',
        'nook[]†',
        'room_1[meeting_room]†',
      ],
    });
  });

  it('shows what a sync would do with ?dryRun=true, and keeps none of it', async () => {
    const preview = await sync('?dryRun=true').expect(200);

    expect(preview.body).toMatchObject({
      dryRun: true,
      changed: true,
      maps: [{ outcome: 'created' }],
    });
    await expect(rows()).resolves.toEqual({ maps: [], spaces: [] });
    await expect(db.select().from(auditLog)).resolves.toEqual([]);

    const real = await sync().expect(200);
    expect({ ...real.body, dryRun: true }).toEqual(preview.body);
  });

  /**
   * Each call reads every published map from another service. Nobody needs
   * to do that more than a few times a minute.
   */
  it('allows ten calls a minute, dry runs included', async () => {
    const limited = await boot(true);
    try {
      const call = () =>
        request(limited.getHttpServer())
          .post('/v1/maps/sync?dryRun=true')
          .set('Cookie', adminCookie);
      for (let i = 0; i < 10; i++) {
        await call().expect(200);
      }

      const res = await call().expect(429);

      expect(res.body.error.code).toBe('RATE_LIMITED');
    } finally {
      await limited.close();
    }
  });

  it('refuses a dryRun that is not true or false', async () => {
    const res = await sync('?dryRun=maybe').expect(400);

    expect(res.body.error.details.fields).toHaveProperty('dryRun');
  });

  /** For whoever publishes maps to put right: it has to say what is wrong. */
  it('answers 409 with the problems when what is published cannot be adopted, and changes nothing', async () => {
    await sync().expect(200);
    const before = await rows();
    publish({ entry: false, spaces: [{ key: '_default' }] });

    const res = await sync().expect(409);

    expect(res.body.error).toMatchObject({
      code: 'CONFLICT',
      message: 'The published maps cannot be adopted as they are.',
    });
    expect(res.body.error.details.problems).toEqual([
      expect.stringMatching(/spawn/),
      expect.stringMatching(/"_default" on "campus"/),
    ]);
    await expect(rows()).resolves.toEqual(before);
  });

  it('answers 409 when nothing is published', async () => {
    sanity = fakeSanity({}).fetch;

    const res = await sync().expect(409);

    expect(res.body.error.details.problems).toEqual([
      'No maps have been published.',
    ]);
  });

  it('answers 503 when Sanity cannot be reached, and changes nothing', async () => {
    await sync().expect(200);
    const before = await rows();
    sanity = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;

    const res = await sync().expect(503);

    expect(res.body.error).toEqual({
      code: 'SERVICE_UNAVAILABLE',
      message: 'The published maps could not be reached. Try again shortly.',
      details: { reason: 'unreachable' },
    });
    await expect(rows()).resolves.toEqual(before);
  });
});
