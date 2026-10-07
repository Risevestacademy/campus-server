import { PGlite } from '@electric-sql/pglite';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from './../src/app.module.js';
import * as schema from './../src/infra/database/schema/index.js';
import { DRIZZLE } from './../src/infra/database/database.constants.js';
import {
  EMAIL_SENDER,
  type OutgoingEmail,
} from './../src/infra/email/email-sender.js';
import { SessionIssuer } from './../src/modules/auth/session-issuer.js';
import { cohortTracks, cohorts } from './../src/modules/cohorts/schema.js';
import { invites } from './../src/modules/invites/schema.js';
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
const db = drizzle(new PGlite(), { schema });

/**
 * A rate limiter that never counts. The route allows five uploads a minute,
 * which the tests below would run through in a second; the limit itself has
 * its own test, against an app that keeps the real one.
 */
const unlimited = {
  increment: async () => ({
    totalHits: 1,
    timeToExpire: 0,
    isBlocked: false,
    timeToBlockExpire: 0,
  }),
};

const sent: OutgoingEmail[] = [];

async function boot(limited: boolean): Promise<INestApplication<App>> {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE)
    .useValue(db)
    .overrideProvider(EMAIL_SENDER)
    .useValue({
      enabled: true,
      send: (email: OutgoingEmail) => {
        sent.push(email);
        return Promise.resolve({ ok: true, id: 'em_1' });
      },
    });
  if (!limited) {
    builder = builder.overrideProvider(ThrottlerStorage).useValue(unlimited);
  }
  const app: INestApplication<App> = (
    await builder.compile()
  ).createNestApplication();
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
  // Listening once, rather than app.init(): supertest otherwise opens a
  // server on a new port for every request, and files running in parallel
  // collide on them.
  await app.listen(0);
  return app;
}

/**
 * The upload itself: a real multipart request, through the file interceptor,
 * to real invites and real emails handed to a fake sender. The row rules are
 * proven in the service spec; this is what only a request can show — that
 * the file arrives, that its size is capped, and who may send it.
 */
describe('POST /v1/invites/import (e2e)', () => {
  let app: INestApplication<App>;
  let adminToken: string;
  let memberToken: string;
  let cohortId: string;

  // Real tokens from the real issuer, so these hold whatever a session
  // token is made to carry.
  const tokenFor = async (user: typeof users.$inferSelect) =>
    (await app.get(SessionIssuer).issueFullAccess(user, { endsAt: null }))
      .token;

  const upload = (
    csv: string | Buffer | null,
    { token = adminToken, cohort = cohortId as string | null } = {},
  ) => {
    const req = request(app.getHttpServer())
      .post('/v1/invites/import')
      .set('Authorization', `Bearer ${token}`);
    if (cohort !== null) req.field('cohortId', cohort);
    if (csv !== null) {
      req.attach('file', Buffer.isBuffer(csv) ? csv : Buffer.from(csv), {
        filename: 'intake.csv',
        contentType: 'text/csv',
      });
    }
    return req;
  };

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    app = await boot(false);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate audit_log, refresh_tokens, invites, cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
    );
    sent.length = 0;

    const [admin, member] = await db
      .insert(users)
      .values([
        { email: 'admin@campus.local', systemRole: SystemRole.Admin },
        { email: 'member@campus.local' },
      ])
      .returning();
    const [track] = await db
      .insert(tracks)
      .values({ name: 'Software Engineering', code: 'SE' })
      .returning();
    const [cohort] = await db
      .insert(cohorts)
      .values({ name: 'Cohort 1', code: 'C1' })
      .returning();
    await db
      .insert(cohortTracks)
      .values({ cohortId: cohort.id, trackId: track.id });
    cohortId = cohort.id;
    adminToken = await tokenFor(admin);
    memberToken = await tokenFor(member);
  });

  it('invites every row, emails each, and reports them in file order', async () => {
    const res = await upload(
      'email,role,track\nada@campus.local,student,SE\ngrace@campus.local,professor,\n',
    ).expect(200);

    expect(res.body).toMatchObject({ total: 2, invited: 2, failed: 0 });
    expect(res.body.rows).toEqual([
      {
        line: 2,
        email: 'ada@campus.local',
        outcome: 'invited',
        inviteId: expect.any(String),
        inviteLink: expect.stringContaining('/invitation?token='),
        emailStatus: 'sent',
      },
      expect.objectContaining({
        line: 3,
        email: 'grace@campus.local',
        outcome: 'invited',
      }),
    ]);
    expect(sent.map((email) => email.to).sort()).toEqual([
      'ada@campus.local',
      'grace@campus.local',
    ]);
    expect(await db.select().from(invites)).toHaveLength(2);
  });

  it('answers 200 with the failures listed when only some rows work', async () => {
    const res = await upload(
      'email,role,track\nada@campus.local,student,SE\nnope,student,SE\nb@campus.local,student,XX\n',
    ).expect(200);

    expect(res.body).toMatchObject({ total: 3, invited: 1, failed: 2 });
    expect(res.body.rows[1]).toEqual({
      line: 3,
      email: 'nope',
      outcome: 'failed',
      reason: 'email is not a valid address',
    });
    expect(res.body.rows[2].reason).toBe(
      'This cohort does not run a track with code XX',
    );
    expect(sent).toHaveLength(1);
  });

  it('makes invites that work: the link opens the preview', async () => {
    const res = await upload('email,role\ngrace@campus.local,mentor\n').expect(
      200,
    );
    const token = new URL(res.body.rows[0].inviteLink).searchParams.get(
      'token',
    );

    const preview = await request(app.getHttpServer())
      .post('/v1/invites/preview')
      .send({ token })
      .expect(200);

    expect(preview.body).toMatchObject({
      email: 'grace@campus.local',
      cohortRole: 'mentor',
      cohort: { code: 'C1' },
    });
  });

  describe('a request that invites nobody', () => {
    const noInvites = async () =>
      expect(await db.select().from(invites)).toHaveLength(0);

    it('refuses a file with a required column missing', async () => {
      const res = await upload('email,track\nada@campus.local,SE\n').expect(
        400,
      );

      expect(res.body.error).toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: 'The first row must name the columns, and "role" is missing',
      });
      await noInvites();
    });

    it('refuses a request with no file', async () => {
      const res = await upload(null).expect(400);

      expect(res.body.error.details.fields.file).toEqual(expect.any(String));
    });

    it.each([
      ['missing', null],
      ['not a UUID', 'cohort-1'],
    ])('refuses a cohortId that is %s', async (_label, cohort) => {
      const res = await upload('email,role\nada@campus.local,mentor\n', {
        cohort,
      }).expect(400);

      expect(res.body.error.details.fields.cohortId).toEqual(
        expect.any(String),
      );
      await noInvites();
    });

    it('answers 404 for a cohort that does not exist', async () => {
      await upload('email,role\nada@campus.local,mentor\n', {
        cohort: '99999999-9999-4999-8999-999999999999',
      }).expect(404);
      await noInvites();
    });

    // Capped by the interceptor before the body is read into memory.
    it('refuses a file over 256 KB', async () => {
      const big = Buffer.alloc(256 * 1024 + 1, 'a');

      await upload(big).expect(413);
      await noInvites();
    });

    it('refuses more than 500 rows', async () => {
      const csv =
        'email,role\n' +
        Array.from({ length: 501 }, (_, i) => `p${i}@campus.local,mentor`).join(
          '\n',
        );

      const res = await upload(csv).expect(400);

      expect(res.body.error.message).toContain('at most 500 invites');
      await noInvites();
    });
  });

  it('is for admins only', async () => {
    const csv = 'email,role\nada@campus.local,mentor\n';

    await upload(csv, { token: memberToken }).expect(403);
    await request(app.getHttpServer())
      .post('/v1/invites/import')
      .field('cohortId', cohortId)
      .attach('file', Buffer.from(csv), 'intake.csv')
      .expect(401);
    expect(await db.select().from(invites)).toHaveLength(0);
  });

  // `import` sits beside `:id/revoke`; it must never be taken for an id.
  it('is not shadowed by the routes that take an invite id', async () => {
    const res = await upload('email,role\nada@campus.local,mentor\n');

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
  });

  // One call can send hundreds of emails, so the route is held to five a
  // minute. Its own app, since the one above has the limiter switched off.
  it('allows five uploads a minute, and refuses the sixth', async () => {
    const limitedApp = await boot(true);
    const token = (
      await limitedApp.get(SessionIssuer).issueFullAccess(
        (
          await db
            .select()
            .from(users)
            .where(sql`${users.email} = 'admin@campus.local'`)
        )[0],
        { endsAt: null },
      )
    ).token;
    const once = (n: number) =>
      request(limitedApp.getHttpServer())
        .post('/v1/invites/import')
        .set('Authorization', `Bearer ${token}`)
        .field('cohortId', cohortId)
        .attach(
          'file',
          Buffer.from(`email,role\np${n}@campus.local,mentor\n`),
          {
            filename: 'intake.csv',
            contentType: 'text/csv',
          },
        );

    try {
      for (let n = 0; n < 5; n += 1) {
        await once(n).expect(200);
      }
      const refused = await once(5).expect(429);
      expect(refused.body.error.code).toBe('RATE_LIMITED');
    } finally {
      await limitedApp.close();
    }
  });
});
