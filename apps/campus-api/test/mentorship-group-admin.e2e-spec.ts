import { PGlite } from '@electric-sql/pglite';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from './../src/app.module.js';
import * as schema from './../src/infra/database/schema/index.js';
import { DRIZZLE } from './../src/infra/database/database.constants.js';
import {
  disabledEmailSender,
  EMAIL_SENDER,
} from './../src/infra/email/email-sender.js';
import {
  AuditAction,
  AuditSubjectType,
  auditLog,
} from './../src/modules/audit/schema.js';
import { SESSION_COOKIE } from './../src/modules/auth/session-cookie.js';
import { InviteDecision } from './../src/modules/invites/dto/invite-decision.dto.js';
import { InviteStatus, invites } from './../src/modules/invites/schema.js';
import { CohortRole, StudentStatus } from './../src/modules/cohorts/schema.js';
import { SystemRole, users } from './../src/modules/users/schema.js';
import { ValidationException } from './../src/shared/exceptions/index.js';
import {
  DomainExceptionFilter,
  GlobalExceptionFilter,
  ValidationExceptionFilter,
} from './../src/shared/filters/index.js';
import { SessionScope, signSessionToken } from '@campus/session';

const MIGRATIONS = fileURLToPath(
  new URL('../src/infra/database/migrations', import.meta.url),
);
const SECRET = 'an-e2e-session-secret-of-at-least-32-chars';
const MISSING = '99999999-9999-4999-8999-999999999999';
const unlimited = {
  increment: async () => ({
    totalHits: 1,
    timeToExpire: 0,
    isBlocked: false,
    timeToBlockExpire: 0,
  }),
};
const db = drizzle(new PGlite(), { schema });

describe('mentorship group admin routes (e2e)', () => {
  let app: INestApplication<App>;
  let adminCookie: string;
  let memberCookie: string;
  let adminId: string;

  const as = (cookie: string) => ({
    get: (path: string) =>
      request(app.getHttpServer()).get(path).set('Cookie', cookie),
    post: (path: string, body: object) =>
      request(app.getHttpServer())
        .post(path)
        .set('Cookie', cookie)
        .set('Origin', 'http://localhost:3000')
        .send(body),
    patch: (path: string, body: object) =>
      request(app.getHttpServer())
        .patch(path)
        .set('Cookie', cookie)
        .set('Origin', 'http://localhost:3000')
        .send(body),
    del: (path: string) =>
      request(app.getHttpServer())
        .delete(path)
        .set('Cookie', cookie)
        .set('Origin', 'http://localhost:3000'),
  });

  const cookieFor = async (
    user: { id: string; email: string },
    scope: SessionScope = SessionScope.FullAccess,
    inviteId?: string,
    epoch = 0,
  ) => {
    const { token } = await signSessionToken(
      { epoch, userId: user.id, email: user.email, scope, inviteId },
      { secret: SECRET, ttlMinutes: 15 },
    );
    return `${SESSION_COOKIE}=${token}`;
  };

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DRIZZLE)
      .useValue(db)
      .overrideProvider(EMAIL_SENDER)
      .useValue(disabledEmailSender)
      .overrideProvider(ThrottlerStorage)
      .useValue(unlimited)
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
    await db.execute(
      sql`truncate mentorship_group_students, mentorship_groups, invites, audit_log, cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
    );
    const [admin] = await db
      .insert(users)
      .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
      .returning();
    const [member] = await db
      .insert(users)
      .values({ email: 'member@campus.local', systemRole: SystemRole.User })
      .returning();
    adminId = admin.id;
    adminCookie = await cookieFor(admin);
    memberCookie = await cookieFor(member);
  });

  const user = async (email: string) => {
    const [row] = await db
      .insert(users)
      .values({ email, systemRole: SystemRole.User })
      .returning();
    return row;
  };

  const member = async (
    cohortId: string,
    userId: string,
    role: CohortRole,
    cohortTrackId?: string,
  ) => {
    const [row] = await db
      .insert(schema.cohortMembers)
      .values({
        cohortId,
        userId,
        role,
        ...(role === CohortRole.Student
          ? { cohortTrackId, status: StudentStatus.Active }
          : {}),
      })
      .returning();
    return row;
  };

  const cohort = async (code = 'C1', name = 'Cohort 1') =>
    (await as(adminCookie).post('/v1/cohorts', { name, code }).expect(201))
      .body;

  const track = async (code = 'SE', name = 'Software Engineering') =>
    (await as(adminCookie).post('/v1/tracks', { name, code }).expect(201)).body;

  const link = async (cohortId: string, trackId: string) =>
    (
      await as(adminCookie)
        .post(`/v1/cohorts/${cohortId}/tracks`, { trackId })
        .expect(201)
    ).body;

  /** A cohort with two mentors and two students, all in it. */
  const world = async () => {
    const c = await cohort();
    const t = await track();
    const ct = await link(c.id, t.id);
    const mentor1 = await user('mentor1@campus.local');
    const mentor2 = await user('mentor2@campus.local');
    const student1 = await user('student1@campus.local');
    const student2 = await user('student2@campus.local');
    return {
      cohort: c,
      cohortTrackId: ct.id,
      mentor1: await member(c.id, mentor1.id, CohortRole.Mentor),
      mentor2: await member(c.id, mentor2.id, CohortRole.Mentor),
      student1: await member(c.id, student1.id, CohortRole.Student, ct.id),
      student2: await member(c.id, student2.id, CohortRole.Student, ct.id),
      mentor1User: mentor1,
    };
  };

  const createGroup = (
    cohortId: string,
    mentorMemberId: string,
    body: object = {},
  ) =>
    as(adminCookie).post(`/v1/cohorts/${cohortId}/mentorship-groups`, {
      name: 'Pod A',
      mentorMemberId,
      ...body,
    });

  describe('access', () => {
    it.each([
      ['post', `/v1/cohorts/${MISSING}/mentorship-groups`],
      ['get', `/v1/cohorts/${MISSING}/mentorship-groups`],
      ['get', `/v1/cohorts/${MISSING}/mentorship-groups/${MISSING}`],
      ['patch', `/v1/cohorts/${MISSING}/mentorship-groups/${MISSING}`],
      ['patch', `/v1/cohorts/${MISSING}/mentorship-groups/${MISSING}/mentor`],
      ['post', `/v1/cohorts/${MISSING}/mentorship-groups/${MISSING}/students`],
      [
        'delete',
        `/v1/cohorts/${MISSING}/mentorship-groups/${MISSING}/students/${MISSING}`,
      ],
      ['delete', `/v1/cohorts/${MISSING}/mentorship-groups/${MISSING}`],
    ] as const)('refuses %s %s without a session', async (method, path) => {
      await request(app.getHttpServer())[method](path).expect(401);
    });

    it.each([
      ['post', `/v1/cohorts/${MISSING}/mentorship-groups`],
      ['get', `/v1/cohorts/${MISSING}/mentorship-groups`],
      ['get', `/v1/cohorts/${MISSING}/mentorship-groups/${MISSING}`],
      ['patch', `/v1/cohorts/${MISSING}/mentorship-groups/${MISSING}`],
      ['patch', `/v1/cohorts/${MISSING}/mentorship-groups/${MISSING}/mentor`],
      ['post', `/v1/cohorts/${MISSING}/mentorship-groups/${MISSING}/students`],
      [
        'delete',
        `/v1/cohorts/${MISSING}/mentorship-groups/${MISSING}/students/${MISSING}`,
      ],
      ['delete', `/v1/cohorts/${MISSING}/mentorship-groups/${MISSING}`],
    ] as const)('refuses %s %s to a non-admin', async (method, path) => {
      const res =
        method === 'get'
          ? await as(memberCookie).get(path)
          : method === 'delete'
            ? await as(memberCookie).del(path)
            : method === 'patch'
              ? await as(memberCookie).patch(path, {})
              : await as(memberCookie).post(path, {});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('the group lifecycle', () => {
    it('creates, edits, reassigns, lists, removes students and deletes, recording each change', async () => {
      const w = await world();

      const created = (
        await createGroup(w.cohort.id, w.mentor1.id, {
          description: 'Backend pod',
        }).expect(201)
      ).body;
      expect(created).toMatchObject({
        cohortId: w.cohort.id,
        name: 'Pod A',
        description: 'Backend pod',
        mentor: { cohortMemberId: w.mentor1.id },
        students: [],
      });

      const added1 = (
        await as(adminCookie)
          .post(
            `/v1/cohorts/${w.cohort.id}/mentorship-groups/${created.id}/students`,
            { cohortMemberId: w.student1.id },
          )
          .expect(201)
      ).body;
      expect(added1.students).toEqual([
        expect.objectContaining({
          cohortMemberId: w.student1.id,
          user: expect.objectContaining({ email: 'student1@campus.local' }),
        }),
      ]);

      const added2 = (
        await as(adminCookie)
          .post(
            `/v1/cohorts/${w.cohort.id}/mentorship-groups/${created.id}/students`,
            { cohortMemberId: w.student2.id },
          )
          .expect(201)
      ).body;
      expect(added2.students).toHaveLength(2);

      const renamed = (
        await as(adminCookie)
          .patch(`/v1/cohorts/${w.cohort.id}/mentorship-groups/${created.id}`, {
            name: 'Pod One',
            description: null,
          })
          .expect(200)
      ).body;
      expect(renamed).toMatchObject({
        name: 'Pod One',
        description: null,
      });

      const reassigned = (
        await as(adminCookie)
          .patch(
            `/v1/cohorts/${w.cohort.id}/mentorship-groups/${created.id}/mentor`,
            { mentorMemberId: w.mentor2.id },
          )
          .expect(200)
      ).body;
      expect(reassigned.mentor.cohortMemberId).toBe(w.mentor2.id);

      const listed = (
        await as(adminCookie)
          .get(`/v1/cohorts/${w.cohort.id}/mentorship-groups`)
          .expect(200)
      ).body;
      expect(listed.items).toEqual([
        expect.objectContaining({
          id: created.id,
          mentor: expect.objectContaining({
            cohortMemberId: w.mentor2.id,
          }),
          students: expect.arrayContaining([
            expect.objectContaining({ cohortMemberId: w.student1.id }),
            expect.objectContaining({ cohortMemberId: w.student2.id }),
          ]),
        }),
      ]);

      const one = (
        await as(adminCookie)
          .get(`/v1/cohorts/${w.cohort.id}/mentorship-groups/${created.id}`)
          .expect(200)
      ).body;
      expect(one.id).toBe(created.id);

      await as(adminCookie)
        .del(
          `/v1/cohorts/${w.cohort.id}/mentorship-groups/${created.id}/students/${w.student1.id}`,
        )
        .expect(204);

      const afterRemoval = (
        await as(adminCookie)
          .get(`/v1/cohorts/${w.cohort.id}/mentorship-groups/${created.id}`)
          .expect(200)
      ).body;
      expect(
        afterRemoval.students.map(
          (s: { cohortMemberId: string }) => s.cohortMemberId,
        ),
      ).toEqual([w.student2.id]);

      await as(adminCookie)
        .del(`/v1/cohorts/${w.cohort.id}/mentorship-groups/${created.id}`)
        .expect(204);
      await as(adminCookie)
        .get(`/v1/cohorts/${w.cohort.id}/mentorship-groups/${created.id}`)
        .expect(404);

      const entries = await db.select().from(auditLog);
      const actions = entries.map((entry) => entry.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          AuditAction.MentorshipGroupCreated,
          AuditAction.MentorshipGroupStudentAdded,
          AuditAction.MentorshipGroupUpdated,
          AuditAction.MentorshipGroupMentorChanged,
          AuditAction.MentorshipGroupStudentRemoved,
          AuditAction.MentorshipGroupDeleted,
        ]),
      );
      for (const entry of entries.filter((row) =>
        row.action.startsWith('mentorship_group'),
      )) {
        expect(entry.actorUserId).toBe(adminId);
      }

      const added = entries.filter(
        (entry) => entry.action === AuditAction.MentorshipGroupStudentAdded,
      );
      expect(added).toHaveLength(2);
      for (const entry of added) {
        expect(entry.details).not.toHaveProperty('inviteId');
      }
    });

    it('refuses duplicate names, a second group for a mentor, and a second group for a student', async () => {
      const w = await world();
      const first = (await createGroup(w.cohort.id, w.mentor1.id).expect(201))
        .body;

      await createGroup(w.cohort.id, w.mentor2.id, { name: 'pod a' }).expect(
        409,
      );
      await createGroup(w.cohort.id, w.mentor1.id, { name: 'Pod B' }).expect(
        409,
      );

      await as(adminCookie)
        .post(
          `/v1/cohorts/${w.cohort.id}/mentorship-groups/${first.id}/students`,
          { cohortMemberId: w.student1.id },
        )
        .expect(201);

      const other = (
        await createGroup(w.cohort.id, w.mentor2.id, { name: 'Pod B' }).expect(
          201,
        )
      ).body;
      await as(adminCookie)
        .post(
          `/v1/cohorts/${w.cohort.id}/mentorship-groups/${other.id}/students`,
          { cohortMemberId: w.student1.id },
        )
        .expect(409);

      await as(adminCookie)
        .post(
          `/v1/cohorts/${w.cohort.id}/mentorship-groups/${first.id}/students`,
          { cohortMemberId: w.student1.id },
        )
        .expect(409);
    });

    it('answers 400 for a membership from another cohort or the wrong role', async () => {
      const w = await world();
      const otherCohort = await cohort('C2', 'Cohort 2');
      const otherTrack = await track('DS', 'Data Science');
      const otherLink = await link(otherCohort.id, otherTrack.id);
      const otherMentorUser = await user('other-mentor@campus.local');
      const otherStudentUser = await user('other-student@campus.local');
      const otherMentor = await member(
        otherCohort.id,
        otherMentorUser.id,
        CohortRole.Mentor,
      );
      const otherStudent = await member(
        otherCohort.id,
        otherStudentUser.id,
        CohortRole.Student,
        otherLink.id,
      );

      await createGroup(w.cohort.id, otherMentor.id).expect(404);

      const group = (await createGroup(w.cohort.id, w.mentor1.id).expect(201))
        .body;
      await as(adminCookie)
        .post(
          `/v1/cohorts/${w.cohort.id}/mentorship-groups/${group.id}/students`,
          { cohortMemberId: otherStudent.id },
        )
        .expect(404);

      // A mentor is not a student, even in the same cohort.
      await as(adminCookie)
        .post(
          `/v1/cohorts/${w.cohort.id}/mentorship-groups/${group.id}/students`,
          { cohortMemberId: w.mentor2.id },
        )
        .expect(400);
    });
  });

  describe('membership endings', () => {
    it('refuses to end a mentor’s membership while they lead a group', async () => {
      const w = await world();
      await createGroup(w.cohort.id, w.mentor1.id).expect(201);

      const res = await as(adminCookie)
        .post(
          `/v1/cohorts/${w.cohort.id}/members/${w.mentor1User.id}/remove`,
          {},
        )
        .expect(409);
      expect(res.body.error.message).toMatch(/Reassign/);

      const group = (
        await as(adminCookie)
          .get(`/v1/cohorts/${w.cohort.id}/mentorship-groups`)
          .expect(200)
      ).body.items[0];
      await as(adminCookie)
        .patch(
          `/v1/cohorts/${w.cohort.id}/mentorship-groups/${group.id}/mentor`,
          { mentorMemberId: w.mentor2.id },
        )
        .expect(200);

      await as(adminCookie)
        .post(
          `/v1/cohorts/${w.cohort.id}/members/${w.mentor1User.id}/remove`,
          {},
        )
        .expect(200);
    });

    it('takes a student out of their group when their membership ends', async () => {
      const w = await world();
      const group = (await createGroup(w.cohort.id, w.mentor1.id).expect(201))
        .body;
      await as(adminCookie)
        .post(
          `/v1/cohorts/${w.cohort.id}/mentorship-groups/${group.id}/students`,
          { cohortMemberId: w.student1.id },
        )
        .expect(201);

      const studentUser = await db.query.users.findFirst({
        where: eq(users.email, 'student1@campus.local'),
      });
      await as(adminCookie)
        .post(
          `/v1/cohorts/${w.cohort.id}/members/${studentUser!.id}/remove`,
          {},
        )
        .expect(200);

      const after = (
        await as(adminCookie)
          .get(`/v1/cohorts/${w.cohort.id}/mentorship-groups/${group.id}`)
          .expect(200)
      ).body;
      expect(after.students).toEqual([]);
    });
  });

  describe('invites', () => {
    it('refuses a group that does not exist, or belongs to another cohort', async () => {
      const w = await world();
      const otherCohort = await cohort('C2', 'Cohort 2');
      const otherTrack = await track('DS', 'Data Science');
      await link(otherCohort.id, otherTrack.id);
      const otherMentorUser = await user('other-mentor@campus.local');
      const otherMentor = await member(
        otherCohort.id,
        otherMentorUser.id,
        CohortRole.Mentor,
      );
      const otherGroup = (
        await createGroup(otherCohort.id, otherMentor.id).expect(201)
      ).body;

      const missing = await as(adminCookie)
        .post('/v1/invites', {
          email: 'nobody@campus.local',
          cohortId: w.cohort.id,
          cohortRole: CohortRole.Student,
          cohortTrackId: w.cohortTrackId,
          mentorshipGroupId: MISSING,
        })
        .expect(404);
      expect(missing.body.error).toMatchObject({
        code: 'NOT_FOUND',
        message: `Mentorship group ${MISSING} not found`,
        details: { mentorshipGroupId: MISSING },
      });

      const res = await as(adminCookie)
        .post('/v1/invites', {
          email: 'wrong-cohort@campus.local',
          cohortId: w.cohort.id,
          cohortRole: CohortRole.Student,
          cohortTrackId: w.cohortTrackId,
          mentorshipGroupId: otherGroup.id,
        })
        .expect(400);
      expect(res.body.error.message).toBe(
        'mentorshipGroupId does not belong to cohortId',
      );
    });

    const inviteTo = async (
      cohortId: string,
      cohortTrackId: string,
      groupId: string,
      status: InviteStatus,
      expiresAt = new Date(Date.now() + 86_400_000),
    ) => {
      const [row] = await db
        .insert(invites)
        .values({
          email: `invite-${status}@campus.local`,
          tokenHash: `invite-${status}-hash`,
          invitedBy: adminId,
          expiresAt,
          cohortId,
          cohortTrackId,
          mentorshipGroupId: groupId,
          cohortRole: CohortRole.Student,
          systemRole: SystemRole.User,
          status,
        })
        .returning();
      return row;
    };

    const deleteGroup = (cohortId: string, groupId: string) =>
      as(adminCookie).del(
        `/v1/cohorts/${cohortId}/mentorship-groups/${groupId}`,
      );

    const deleteEntries = () =>
      db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, AuditAction.MentorshipGroupDeleted));

    it.each([
      InviteStatus.Revoked,
      InviteStatus.Expired,
      InviteStatus.Accepted,
      InviteStatus.Declined,
    ])(
      'deletes the group when the only invite is %s, clearing only its group id',
      async (status) => {
        const w = await world();
        const group = (await createGroup(w.cohort.id, w.mentor1.id).expect(201))
          .body;
        const invite = await inviteTo(
          w.cohort.id,
          w.cohortTrackId,
          group.id,
          status,
        );

        await deleteGroup(w.cohort.id, group.id).expect(204);

        const after = await db.query.invites.findFirst({
          where: eq(invites.id, invite.id),
        });
        expect(after).toEqual({ ...invite, mentorshipGroupId: null });

        const entries = await deleteEntries();
        expect(entries).toEqual([
          expect.objectContaining({
            actorUserId: adminId,
            subjectType: AuditSubjectType.MentorshipGroup,
            subjectId: group.id,
          }),
        ]);
      },
    );

    it('deletes after an invite is revoked through the route', async () => {
      const w = await world();
      const group = (await createGroup(w.cohort.id, w.mentor1.id).expect(201))
        .body;
      const created = (
        await as(adminCookie)
          .post('/v1/invites', {
            email: 'revoked-route@campus.local',
            cohortId: w.cohort.id,
            cohortRole: CohortRole.Student,
            cohortTrackId: w.cohortTrackId,
            mentorshipGroupId: group.id,
          })
          .expect(201)
      ).body;

      await as(adminCookie)
        .post(`/v1/invites/${created.id}/revoke`)
        .expect(200);

      const revoked = await db.query.invites.findFirst({
        where: eq(invites.id, created.id),
      });
      await deleteGroup(w.cohort.id, group.id).expect(204);

      expect(
        await db.query.invites.findFirst({
          where: eq(invites.id, created.id),
        }),
      ).toEqual({ ...revoked, mentorshipGroupId: null });
    });

    it.each([
      ['a live pending invite', new Date(Date.now() + 86_400_000)],
      ['a lapsed-but-pending invite', new Date(Date.now() - 86_400_000)],
    ])('refuses to delete for %s', async (_label, expiresAt) => {
      const w = await world();
      const group = (await createGroup(w.cohort.id, w.mentor1.id).expect(201))
        .body;
      const invite = await inviteTo(
        w.cohort.id,
        w.cohortTrackId,
        group.id,
        InviteStatus.Pending,
        expiresAt,
      );

      const res = await deleteGroup(w.cohort.id, group.id).expect(409);
      expect(res.body.error).toMatchObject({
        code: 'CONFLICT',
        message:
          'Mentorship group cannot be deleted while a pending invite names it',
        details: {
          cohortId: w.cohort.id,
          groupId: group.id,
          inviteId: invite.id,
        },
      });

      expect(
        await db.query.invites.findFirst({
          where: eq(invites.id, invite.id),
        }),
      ).toEqual(invite);
      expect(
        await as(adminCookie)
          .get(`/v1/cohorts/${w.cohort.id}/mentorship-groups/${group.id}`)
          .expect(200),
      ).toBeDefined();
      expect(await deleteEntries()).toHaveLength(0);
    });

    it('puts an accepted group invite’s student into the group', async () => {
      const w = await world();
      const group = (await createGroup(w.cohort.id, w.mentor1.id).expect(201))
        .body;
      const invitee = await user('invitee@campus.local');
      const [invite] = await db
        .insert(invites)
        .values({
          email: invitee.email,
          tokenHash: 'invitee-hash',
          invitedBy: adminId,
          expiresAt: new Date(Date.now() + 86_400_000),
          cohortId: w.cohort.id,
          cohortTrackId: w.cohortTrackId,
          mentorshipGroupId: group.id,
          cohortRole: CohortRole.Student,
          systemRole: SystemRole.User,
          status: InviteStatus.Pending,
        })
        .returning();

      await request(app.getHttpServer())
        .post('/v1/invites/decision')
        .set(
          'Cookie',
          await cookieFor(invitee, SessionScope.Provisional, invite.id),
        )
        .set('Origin', 'http://localhost:3000')
        .send({ decision: InviteDecision.Accept, inviteId: invite.id })
        .expect(200);

      const after = (
        await as(adminCookie)
          .get(`/v1/cohorts/${w.cohort.id}/mentorship-groups/${group.id}`)
          .expect(200)
      ).body;
      expect(after.students).toEqual([
        expect.objectContaining({
          cohortMemberId: expect.any(String),
          user: expect.objectContaining({ id: invitee.id }),
        }),
      ]);

      const student = await db.query.cohortMembers.findFirst({
        where: eq(schema.cohortMembers.userId, invitee.id),
      });
      const addedEntries = () =>
        db
          .select()
          .from(auditLog)
          .where(eq(auditLog.action, AuditAction.MentorshipGroupStudentAdded));

      expect(await addedEntries()).toEqual([
        expect.objectContaining({
          actorUserId: invitee.id,
          subjectType: AuditSubjectType.MentorshipGroup,
          subjectId: group.id,
          details: {
            cohortId: w.cohort.id,
            cohortMemberId: student!.id,
            inviteId: invite.id,
          },
        }),
      ]);

      // A refused replay writes nothing.
      await request(app.getHttpServer())
        .post('/v1/invites/decision')
        .set(
          'Cookie',
          await cookieFor(invitee, SessionScope.Provisional, invite.id),
        )
        .set('Origin', 'http://localhost:3000')
        .send({ decision: InviteDecision.Accept, inviteId: invite.id })
        .expect(409);
      expect(await addedEntries()).toHaveLength(1);

      const accepted = await db.query.invites.findFirst({
        where: eq(invites.id, invite.id),
      });
      await deleteGroup(w.cohort.id, group.id).expect(204);
      expect(
        await db.query.invites.findFirst({
          where: eq(invites.id, invite.id),
        }),
      ).toEqual({ ...accepted, mentorshipGroupId: null });
    });

    it('adds a fresh link when a revived student accepts a group invite', async () => {
      const w = await world();
      const group = (await createGroup(w.cohort.id, w.mentor1.id).expect(201))
        .body;
      await as(adminCookie)
        .post(
          `/v1/cohorts/${w.cohort.id}/mentorship-groups/${group.id}/students`,
          { cohortMemberId: w.student1.id },
        )
        .expect(201);

      const studentUser = await db.query.users.findFirst({
        where: eq(users.email, 'student1@campus.local'),
      });
      await as(adminCookie)
        .post(
          `/v1/cohorts/${w.cohort.id}/members/${studentUser!.id}/remove`,
          {},
        )
        .expect(200);

      // Ending the membership removed the group link.
      expect(
        await db.query.mentorshipGroupStudents.findMany({
          where: eq(
            schema.mentorshipGroupStudents.cohortMemberId,
            w.student1.id,
          ),
        }),
      ).toEqual([]);

      // Ending the membership revoked the student's sessions, so the
      // provisional token has to be minted against the new epoch.
      const revivedUser = await db.query.users.findFirst({
        where: eq(users.id, studentUser!.id),
      });

      const [invite] = await db
        .insert(invites)
        .values({
          email: revivedUser!.email,
          tokenHash: 'revived-group-hash',
          invitedBy: adminId,
          expiresAt: new Date(Date.now() + 86_400_000),
          cohortId: w.cohort.id,
          cohortTrackId: w.cohortTrackId,
          mentorshipGroupId: group.id,
          cohortRole: CohortRole.Student,
          systemRole: SystemRole.User,
          status: InviteStatus.Pending,
        })
        .returning();

      await request(app.getHttpServer())
        .post('/v1/invites/decision')
        .set(
          'Cookie',
          await cookieFor(
            revivedUser!,
            SessionScope.Provisional,
            invite.id,
            revivedUser!.sessionEpoch,
          ),
        )
        .set('Origin', 'http://localhost:3000')
        .send({ decision: InviteDecision.Accept, inviteId: invite.id })
        .expect(200);

      const links = await db.query.mentorshipGroupStudents.findMany({
        where: eq(schema.mentorshipGroupStudents.cohortMemberId, w.student1.id),
      });
      expect(links).toEqual([
        expect.objectContaining({
          mentorshipGroupId: group.id,
          cohortId: w.cohort.id,
          cohortMemberId: w.student1.id,
        }),
      ]);
    });
  });

  describe('not found and malformed ids', () => {
    it('answers 404 for a group in another cohort, and 400 for a bad uuid', async () => {
      const w = await world();
      const otherCohort = await cohort('C2', 'Cohort 2');
      const otherTrack = await track('DS', 'Data Science');
      await link(otherCohort.id, otherTrack.id);
      const otherMentorUser = await user('other-mentor@campus.local');
      const otherMentor = await member(
        otherCohort.id,
        otherMentorUser.id,
        CohortRole.Mentor,
      );
      const otherGroup = (
        await createGroup(otherCohort.id, otherMentor.id).expect(201)
      ).body;

      await as(adminCookie)
        .get(`/v1/cohorts/${w.cohort.id}/mentorship-groups/${otherGroup.id}`)
        .expect(404);
      await as(adminCookie)
        .get(`/v1/cohorts/${w.cohort.id}/mentorship-groups/not-a-uuid`)
        .expect(400);
      await as(adminCookie)
        .del(`/v1/cohorts/${w.cohort.id}/mentorship-groups/${otherGroup.id}`)
        .expect(404);
    });
  });
});
