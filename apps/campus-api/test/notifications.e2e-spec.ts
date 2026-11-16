import { PGlite } from '@electric-sql/pglite';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  SessionScope,
  signSessionToken,
  type NotificationCreated,
} from '@campus/session';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from './../src/app.module.js';
import { DRIZZLE } from './../src/infra/database/database.constants.js';
import * as schema from './../src/infra/database/schema/index.js';
import { SESSION_COOKIE } from './../src/modules/auth/session-cookie.js';
import {
  CohortRole,
  cohortMembers,
  cohorts,
} from './../src/modules/cohorts/schema.js';
import { NOTIFICATION_PUBLISHER } from './../src/modules/notifications/notification-publisher.js';
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

/** What went to Redis for world, in its place. */
const published: NotificationCreated[] = [];
const publisher = {
  publish: async (messages: readonly NotificationCreated[]) => {
    published.push(...messages);
  },
};

/**
 * A notice posted, through to the member's list: what is published for
 * world to push (world's own tests take it from there to the socket), what
 * the list answers, and marking read one at a time and all at once.
 */
describe('notifications (e2e)', () => {
  let app: INestApplication<App>;
  let admin: typeof users.$inferSelect;
  let member: typeof users.$inferSelect;
  let other: typeof users.$inferSelect;
  let cohortId: string;
  let adminCookie: string;
  let memberCookie: string;
  let otherCookie: string;

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

  const post = (body: object) =>
    request(app.getHttpServer())
      .post('/v1/notices')
      .set('Cookie', adminCookie)
      .send(body)
      .expect(201);
  const list = (query = '', cookie = memberCookie) =>
    request(app.getHttpServer())
      .get(`/v1/notifications${query}`)
      .set('Cookie', cookie);
  const markRead = (id: string, cookie = memberCookie) =>
    request(app.getHttpServer())
      .patch(`/v1/notifications/${id}/read`)
      .set('Cookie', cookie);
  const markAllRead = (cookie = memberCookie) =>
    request(app.getHttpServer())
      .post('/v1/notifications/read-all')
      .set('Cookie', cookie);

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DRIZZLE)
      .useValue(db)
      .overrideProvider(NOTIFICATION_PUBLISHER)
      .useValue(publisher)
      .compile();

    app = moduleFixture.createNestApplication();
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
    published.length = 0;
    await db.execute(
      sql`truncate notifications, audit_log, notices, cohort_members, cohorts, users cascade`,
    );
    [admin, member, other] = await db
      .insert(users)
      .values([
        { email: 'admin@campus.local', systemRole: SystemRole.Admin },
        { email: 'member@campus.local' },
        { email: 'other@campus.local' },
      ])
      .returning();
    const [cohort] = await db
      .insert(cohorts)
      .values({ name: 'Cohort 1', code: 'C1' })
      .returning();
    cohortId = cohort.id;
    await db.insert(cohortMembers).values([
      { cohortId, userId: member.id, role: CohortRole.Mentor },
      { cohortId, userId: other.id, role: CohortRole.Mentor },
    ]);
    adminCookie = await cookieFor(admin);
    memberCookie = await cookieFor(member);
    otherCookie = await cookieFor(other);
  });

  it('takes a posted notice to world, into the list unread, then read, then cleared', async () => {
    const { body: notice } = await post({
      title: 'Welcome',
      body: 'Welcome to campus.',
      scope: 'campus',
    });

    // What world is handed to push to the member's sockets: all of them,
    // a campus notice belonging to no cohort.
    const pushed = published.find((m) => m.recipientId === member.id);
    expect(pushed).toEqual({
      recipientId: member.id,
      cohortId: null,
      id: expect.any(String),
      kind: 'notice_posted',
      referenceType: 'notice',
      referenceId: notice.id,
      context: null,
      createdAt: expect.any(String),
    });

    const unread = await list('?unread=true').expect(200);
    expect(unread.body).toEqual({
      items: [
        {
          id: pushed!.id,
          kind: 'notice_posted',
          referenceType: 'notice',
          referenceId: notice.id,
          context: null,
          read: false,
          createdAt: pushed!.createdAt,
        },
      ],
      meta: { page: 1, perPage: 20, total: 1, totalPages: 1 },
    });

    const marked = await markRead(pushed!.id).expect(200);
    expect(marked.body).toMatchObject({ id: pushed!.id, read: true });
    // Again: nothing changes, and it still answers.
    await markRead(pushed!.id).expect(200);

    expect((await list('?unread=true').expect(200)).body.items).toEqual([]);
    expect((await list().expect(200)).body.items).toEqual([
      expect.objectContaining({ id: pushed!.id, read: true }),
    ]);

    // Two more, then "clear all".
    await post({ title: 'Two', body: 'Second.', scope: 'cohort', cohortId });
    await post({ title: 'Three', body: 'Third.', scope: 'cohort', cohortId });
    expect(
      published
        .filter((m) => m.recipientId === member.id)
        .map((m) => m.cohortId),
    ).toEqual([null, cohortId, cohortId]);

    expect((await markAllRead().expect(200)).body).toEqual({ marked: 2 });
    expect((await list('?unread=true').expect(200)).body.meta.total).toBe(0);
    expect((await markAllRead().expect(200)).body).toEqual({ marked: 0 });
    // Only the member's own were cleared.
    expect(
      (await list('?unread=true', otherCookie).expect(200)).body.meta.total,
    ).toBe(3);
  });

  it("will not mark somebody else's read, and does not say it exists", async () => {
    await post({ title: 'Hi', body: 'Hello.', scope: 'cohort', cohortId });
    const mine = published.find((m) => m.recipientId === member.id)!;

    const res = await markRead(mine.id, otherCookie).expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');
    expect((await list('?unread=true').expect(200)).body.meta.total).toBe(1);
    await markRead('00000000-0000-4000-8000-000000000000').expect(404);
  });

  it('lists only your own', async () => {
    await post({ title: 'Hi', body: 'Hello.', scope: 'cohort', cohortId });

    expect((await list('', adminCookie).expect(200)).body.items).toEqual([]);
  });

  it('refuses without a session', async () => {
    await request(app.getHttpServer()).get('/v1/notifications').expect(401);
    await request(app.getHttpServer())
      .post('/v1/notifications/read-all')
      .expect(401);
  });

  it.each([
    ['an unread that is not true or false', () => list('?unread=yes')],
    ['an id that is not a UUID', () => markRead('not-a-uuid')],
  ])('refuses %s', async (_, send) => {
    await send().expect(400);
  });
});
