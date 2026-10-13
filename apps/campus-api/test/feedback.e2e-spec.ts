import { PGlite } from '@electric-sql/pglite';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SessionScope, signSessionToken } from '@campus/session';
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
  EMAIL_SENDER,
  type OutgoingEmail,
} from './../src/infra/email/email-sender.js';
import { AuditAction, auditLog } from './../src/modules/audit/schema.js';
import { CohortRole } from './../src/modules/cohorts/schema.js';
import { SESSION_COOKIE } from './../src/modules/auth/session-cookie.js';
import { FEEDBACK_MAX_PER_HOUR } from './../src/modules/feedback/feedback.service.js';
import { feedback } from './../src/modules/feedback/schema.js';
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
const NOBODY = '00000000-0000-4000-8000-000000000000';
const db = drizzle(new PGlite(), { schema });

/** Everything sent while a test ran, in place of Resend. */
const sent: OutgoingEmail[] = [];
const sender = {
  enabled: true,
  send: async (email: OutgoingEmail) => {
    sent.push(email);
    return { ok: true as const, id: `email-${sent.length}` };
  },
};

/**
 * The feedback routes around the service: who may send and who may read,
 * that a request reaches the rules as typed, and that a report, and only a
 * report, tells the admins.
 */
describe('feedback (e2e)', () => {
  let app: INestApplication<App>;
  let admin: typeof users.$inferSelect;
  let member: typeof users.$inferSelect;
  let other: typeof users.$inferSelect;
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

  const BUG = {
    type: 'bug',
    title: 'The library door will not open',
    details: 'I walk up to it from the courtyard and nothing happens.',
  };

  const send = (body: object, cookie = memberCookie) =>
    request(app.getHttpServer())
      .post('/v1/feedback')
      .set('Cookie', cookie)
      .set('User-Agent', 'CampusTest/1.0')
      .send(body);
  const list = (query = '', cookie = adminCookie) =>
    request(app.getHttpServer())
      .get(`/v1/feedback${query}`)
      .set('Cookie', cookie);
  const read = (id: string, cookie = adminCookie) =>
    request(app.getHttpServer())
      .get(`/v1/feedback/${id}`)
      .set('Cookie', cookie);
  const setStatus = (id: string, status: string, cookie = adminCookie) =>
    request(app.getHttpServer())
      .patch(`/v1/feedback/${id}`)
      .set('Cookie', cookie)
      .send({ status });

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DRIZZLE)
      .useValue(db)
      .overrideProvider(EMAIL_SENDER)
      .useValue(sender)
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
    // Listening once, rather than app.init(): supertest otherwise opens and
    // closes a server on a new port for every request.
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    sent.length = 0;
    await db.execute(
      sql`truncate audit_log, feedback, cohort_members, cohorts, users cascade`,
    );
    [admin, member, other] = await db
      .insert(users)
      .values([
        { email: 'admin@campus.local', systemRole: SystemRole.Admin },
        { email: 'member@campus.local', displayName: 'Ada Lovelace' },
        { email: 'other@campus.local' },
      ])
      .returning();
    adminCookie = await cookieFor(admin);
    memberCookie = await cookieFor(member);
  });

  describe('sending', () => {
    it('refuses without a session', async () => {
      await request(app.getHttpServer())
        .post('/v1/feedback')
        .send(BUG)
        .expect(401);
    });

    it('takes a member’s feedback and answers that it arrived', async () => {
      const res = await send({
        ...BUG,
        about: '  The library, by the east door  ',
        context: { path: '/campus', mapId: 'campus', x: 75, y: 59 },
      }).expect(201);

      expect(res.body).toEqual({
        id: expect.any(String),
        type: 'bug',
        title: 'The library door will not open',
        createdAt: expect.any(String),
      });
      const [row] = await db.select().from(feedback);
      expect(row).toMatchObject({
        id: res.body.id,
        submittedBy: member.id,
        about: 'The library, by the east door',
        context: { path: '/campus', mapId: 'campus', x: 75, y: 59 },
        userAgent: 'CampusTest/1.0',
        status: 'open',
      });
    });

    /** Who sent it, and whether it is dealt with, are not the sender's to say. */
    it('ignores a sender or a status put in the body', async () => {
      await send({
        ...BUG,
        submittedBy: other.id,
        status: 'resolved',
        resolvedBy: admin.id,
      }).expect(201);

      const [row] = await db.select().from(feedback);
      expect(row).toMatchObject({
        submittedBy: member.id,
        status: 'open',
        resolvedBy: null,
      });
    });

    it('takes every type with "who or where" left out, or left blank', async () => {
      for (const type of ['bug', 'idea', 'report']) {
        await send({ ...BUG, type }).expect(201);
        await send({ ...BUG, type, about: '   ' }).expect(201);
      }

      const rows = await db.select({ about: feedback.about }).from(feedback);
      expect(rows).toHaveLength(6);
      expect(rows.every((row) => row.about === null)).toBe(true);
    });

    it.each([
      ['no title', { ...BUG, title: undefined }, 'title'],
      ['a title of spaces', { ...BUG, title: '   ' }, 'title'],
      ['a title too long', { ...BUG, title: 'x'.repeat(121) }, 'title'],
      ['no details', { ...BUG, details: undefined }, 'details'],
      ['details of line breaks', { ...BUG, details: '\n\n' }, 'details'],
      ['details too long', { ...BUG, details: 'x'.repeat(4_001) }, 'details'],
      ['a type that is not one', { ...BUG, type: 'complaint' }, 'type'],
      ['no type', { ...BUG, type: undefined }, 'type'],
      ['"who or where" too long', { ...BUG, about: 'x'.repeat(201) }, 'about'],
      [
        'a reported account that is not an id',
        { ...BUG, type: 'report', reportedUserId: 'grace' },
        'reportedUserId',
      ],
      [
        'a reported account on a bug',
        { ...BUG, reportedUserId: NOBODY },
        'reportedUserId',
      ],
      [
        'a reported account that does not exist',
        { ...BUG, type: 'report', reportedUserId: NOBODY },
        'reportedUserId',
      ],
      [
        'a cohort that does not exist',
        { ...BUG, cohortId: NOBODY },
        'cohortId',
      ],
      ['a tile off the map', { ...BUG, context: { x: -1 } }, 'context.x'],
      [
        'a list where one context belongs',
        { ...BUG, context: [{ path: '/a' }, { path: '/b' }] },
        'context',
      ],
      // A zero-width space and a next-line: nothing anybody could read.
      ['a title nobody can see', { ...BUG, title: '\u200b\u0085' }, 'title'],
      ['details nobody can see', { ...BUG, details: ' \u0085 ' }, 'details'],
    ])('refuses %s, naming the field', async (_, body, field) => {
      const res = await send(body).expect(400);

      expect(res.body.error.code).toBe('INVALID_ARGUMENT');
      expect(Object.keys(res.body.error.details.fields)).toContain(field);
      await expect(db.select().from(feedback)).resolves.toEqual([]);
    });

    /** A hint about where they were; one they could not have been in is not one. */
    it('takes the cohort a member is in, and refuses one they are not', async () => {
      const [cohort] = await db
        .insert(schema.cohorts)
        .values({ name: 'Cohort 1', code: 'C1' })
        .returning();

      const refused = await send({ ...BUG, cohortId: cohort.id }).expect(400);
      expect(refused.body.error.details.fields).toHaveProperty('cohortId');

      await db.insert(schema.cohortMembers).values({
        cohortId: cohort.id,
        userId: member.id,
        role: CohortRole.Mentor,
      });
      await send({ ...BUG, cohortId: cohort.id }).expect(201);
    });

    it('refuses an account past its hour’s worth, whatever it sends', async () => {
      for (let i = 0; i < FEEDBACK_MAX_PER_HOUR; i++) {
        await send(BUG).expect(201);
      }

      const res = await send({ ...BUG, type: 'idea' }).expect(429);

      expect(res.body.error.code).toBe('RATE_LIMITED');
      // Somebody else is not held up by it.
      await send(BUG, await cookieFor(other)).expect(201);
    });
  });

  describe('telling the admins', () => {
    it('emails every admin when a report arrives, without what it says', async () => {
      await db.insert(users).values({
        email: 'root@campus.local',
        systemRole: SystemRole.SuperAdmin,
      });

      await send({
        type: 'report',
        title: 'Harassment in the town hall',
        details: 'Grace kept following me around and would not stop.',
        about: 'Grace Hopper',
        reportedUserId: other.id,
      }).expect(201);

      // The answer does not wait for the emails, so neither can this.
      await expect
        .poll(() => sent.map((email) => email.to).sort())
        .toEqual(['admin@campus.local', 'root@campus.local']);
      // No cohort on this one, so the link is to the campus list.
      expect(sent[0].text).toContain('/campus');
      expect(sent[0].text).not.toContain('/overview');
      // A report is one member's account of another. None of it is mailed.
      for (const email of sent) {
        const whole = `${email.subject} ${email.text} ${email.html}`;
        for (const said of ['Harassment', 'following', 'Grace', other.email]) {
          expect(whole).not.toContain(said);
        }
      }
    });

    it.each(['bug', 'idea'])('sends nothing for a %s', async (type) => {
      await send({ ...BUG, type }).expect(201);

      // Long enough that an email on its way would have arrived.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(sent).toEqual([]);
    });

    /**
     * Somebody who is reported is not the one to be told, to read who
     * reported them, or to mark it dealt with. Another admin handles it.
     */
    it('keeps a report from the admin it names, in every way', async () => {
      const [root] = await db
        .insert(users)
        .values({
          email: 'root@campus.local',
          systemRole: SystemRole.SuperAdmin,
        })
        .returning();
      const rootCookie = await cookieFor(root);

      const { id } = (
        await send({
          type: 'report',
          title: 'An admin abused their role',
          details: 'What happened.',
          reportedUserId: admin.id,
        }).expect(201)
      ).body;

      await expect
        .poll(() => sent.map((email) => email.to))
        .toEqual(['root@campus.local']);
      await expect(list().then((res) => res.body.items)).resolves.toEqual([]);
      await read(id).expect(404);
      await setStatus(id, 'resolved').expect(404);
      // And it is all there for the admin it does not name.
      await read(id, rootCookie).expect(200);
      await setStatus(id, 'resolved', rootCookie).expect(200);
    });
  });

  describe('reading, for admins', () => {
    let bugId: string;
    let reportId: string;

    beforeEach(async () => {
      bugId = (await send(BUG).expect(201)).body.id;
      reportId = (
        await send({
          type: 'report',
          title: 'Harassment in the town hall',
          details: 'What happened.',
          reportedUserId: other.id,
        }).expect(201)
      ).body.id;
      await db
        .update(feedback)
        .set({ createdAt: new Date('2026-10-10T09:00:00Z') })
        .where(eq(feedback.id, bugId));
    });

    it('refuses without a session, and refuses a member all three ways', async () => {
      await request(app.getHttpServer()).get('/v1/feedback').expect(401);

      // Their own included: nothing lets a member read feedback back.
      await list('', memberCookie).expect(403);
      await read(bugId, memberCookie).expect(403);
      await setStatus(bugId, 'resolved', memberCookie).expect(403);
      const [row] = await db
        .select({ status: feedback.status })
        .from(feedback)
        .where(eq(feedback.id, bugId));
      expect(row.status).toBe('open');
    });

    it('lists newest first, with who sent each and who a report names', async () => {
      const res = await list().expect(200);

      expect(res.body.meta).toEqual({
        page: 1,
        perPage: 20,
        total: 2,
        totalPages: 1,
      });
      expect(res.body.items).toEqual([
        {
          id: reportId,
          type: 'report',
          title: 'Harassment in the town hall',
          about: null,
          status: 'open',
          submittedBy: {
            id: member.id,
            email: 'member@campus.local',
            displayName: 'Ada Lovelace',
          },
          reportedUser: {
            id: other.id,
            email: 'other@campus.local',
            displayName: null,
          },
          createdAt: expect.any(String),
        },
        expect.objectContaining({ id: bugId, reportedUser: null }),
      ]);
      // The details are on the single read, not in the list.
      expect(JSON.stringify(res.body)).not.toContain('What happened.');
    });

    it.each([
      ['?type=report', 1],
      ['?type=idea', 0],
      ['?status=open', 2],
      ['?status=resolved', 0],
      ['?perPage=1', 1],
      ['?perPage=1&page=2', 1],
    ])('reads %s as a filter', async (query, count) => {
      const res = await list(query).expect(200);

      expect(res.body.items).toHaveLength(count);
    });

    it('filters by who sent it', async () => {
      await expect(
        list(`?submittedBy=${member.id}`).then((res) => res.body.meta.total),
      ).resolves.toBe(2);
      await expect(
        list(`?submittedBy=${other.id}`).then((res) => res.body.meta.total),
      ).resolves.toBe(0);
    });

    it.each(['?type=complaint', '?status=closed', '?submittedBy=ada'])(
      'refuses the filter %s',
      async (query) => {
        const res = await list(query).expect(400);

        expect(res.body.error.code).toBe('INVALID_ARGUMENT');
      },
    );

    it('reads one whole', async () => {
      const res = await read(bugId).expect(200);

      expect(res.body).toEqual({
        id: bugId,
        type: 'bug',
        title: 'The library door will not open',
        details: 'I walk up to it from the courtyard and nothing happens.',
        about: null,
        status: 'open',
        submittedBy: {
          id: member.id,
          email: 'member@campus.local',
          displayName: 'Ada Lovelace',
        },
        reportedUser: null,
        cohortId: null,
        context: null,
        userAgent: 'CampusTest/1.0',
        resolvedBy: null,
        resolvedAt: null,
        createdAt: '2026-10-10T09:00:00.000Z',
      });
    });

    it('answers 404 for an id that names nothing and 400 for one that is not an id', async () => {
      const missing = await read(NOBODY).expect(404);
      expect(missing.body.error.code).toBe('NOT_FOUND');

      await read('not-an-id').expect(400);
      await setStatus(NOBODY, 'resolved').expect(404);
      await setStatus('not-an-id', 'resolved').expect(400);
    });

    it('resolves and reopens, recording who and saying so in the audit log', async () => {
      const resolved = await setStatus(reportId, 'resolved').expect(200);

      expect(resolved.body).toMatchObject({
        id: reportId,
        status: 'resolved',
        resolvedBy: { id: admin.id, email: 'admin@campus.local' },
        resolvedAt: expect.any(String),
      });

      const reopened = await setStatus(reportId, 'open').expect(200);

      expect(reopened.body).toMatchObject({
        status: 'open',
        resolvedBy: null,
        resolvedAt: null,
      });
      const entries = await db
        .select({
          action: auditLog.action,
          actorUserId: auditLog.actorUserId,
          subjectId: auditLog.subjectId,
          details: auditLog.details,
        })
        .from(auditLog)
        .orderBy(auditLog.createdAt, auditLog.id);
      expect(entries).toEqual([
        {
          action: AuditAction.FeedbackResolved,
          actorUserId: admin.id,
          subjectId: reportId,
          details: {},
        },
        {
          action: AuditAction.FeedbackReopened,
          actorUserId: admin.id,
          subjectId: reportId,
          details: {},
        },
      ]);
    });

    it('refuses a status that is not one of the two', async () => {
      const res = await setStatus(bugId, 'closed').expect(400);

      expect(res.body.error.details.fields).toHaveProperty('status');
    });
  });
});
