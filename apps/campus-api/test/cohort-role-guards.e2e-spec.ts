import { PGlite } from '@electric-sql/pglite';
import {
  Controller,
  Get,
  INestApplication,
  Post,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Response } from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from './../src/app.module.js';
import * as schema from './../src/infra/database/schema/index.js';
import { DRIZZLE } from './../src/infra/database/database.constants.js';
import {
  disabledEmailSender,
  EMAIL_SENDER,
} from './../src/infra/email/email-sender.js';
import { SESSION_COOKIE } from './../src/modules/auth/session-cookie.js';
import { SessionModule } from './../src/modules/auth/session.module.js';
import { SessionGuard } from './../src/modules/auth/session.guard.js';
import { CohortRole, StudentStatus } from './../src/modules/cohorts/schema.js';
import { SystemRole, users } from './../src/modules/users/schema.js';
import type { AuthenticatedRequest } from './../src/shared/auth/authenticated-user.js';
import {
  MentorOfGroupGuard,
  ProfessorOfTrackGuard,
  ProfessorOfTrackOrMentorOfGroupGuard,
} from './../src/shared/auth/cohort-role.guard.js';
import { CohortRoleModule } from './../src/shared/auth/cohort-role.module.js';
import type { CohortMembership } from './../src/shared/auth/cohort-role.service.js';
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
const ORIGIN = 'http://localhost:3000';
const unlimited = {
  increment: async () => ({
    totalHits: 1,
    timeToExpire: 0,
    isBlocked: false,
    timeToBlockExpire: 0,
  }),
};
const db = drizzle(new PGlite(), { schema });

type GuardedRequest = AuthenticatedRequest & {
  cohortMembership?: CohortMembership;
};

@Controller('test-guards/professor')
@UseGuards(SessionGuard, ProfessorOfTrackGuard)
class ProfessorGuardController {
  @Get(':cohortId/tracks/:trackId')
  get(@Req() req: GuardedRequest): CohortMembership | null {
    return req.cohortMembership ?? null;
  }

  @Post(':cohortId/tracks/:trackId')
  post(@Req() req: GuardedRequest): CohortMembership | null {
    return req.cohortMembership ?? null;
  }
}

@Controller('test-guards/mentor')
@UseGuards(SessionGuard, MentorOfGroupGuard)
class MentorGuardController {
  @Get(':cohortId/groups/:groupId')
  get(@Req() req: GuardedRequest): CohortMembership | null {
    return req.cohortMembership ?? null;
  }
}

@Controller('test-guards/professor-or-mentor')
@UseGuards(SessionGuard, ProfessorOfTrackOrMentorOfGroupGuard)
class CombinedGuardController {
  @Get(':cohortId/tracks/:trackId/groups/:groupId')
  get(@Req() req: GuardedRequest): CohortMembership | null {
    return req.cohortMembership ?? null;
  }
}

@Controller('test-guards/missing')
@UseGuards(SessionGuard, ProfessorOfTrackGuard)
class MissingParamController {
  @Get(':cohortId/only')
  get(): string {
    return 'allowed';
  }
}

describe('cohort role guards (e2e)', () => {
  let app: INestApplication<App>;

  const as = (cookie: string) => ({
    get: (path: string) =>
      request(app.getHttpServer()).get(path).set('Cookie', cookie),
    post: (path: string, body: object) =>
      request(app.getHttpServer())
        .post(path)
        .set('Cookie', cookie)
        .set('Origin', ORIGIN)
        .send(body),
  });

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

  /**
   * A well-signed full-access token that also claims a cohort role. The API
   * never reads that claim; this is here to prove it.
   */
  const tokenClaimingRole = (
    user: { id: string; email: string },
    role: CohortRole,
  ): string => {
    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = encode({ alg: 'HS256', typ: 'JWT' });
    const payload = encode({
      sub: user.id,
      email: user.email,
      scope: SessionScope.FullAccess,
      epoch: 0,
      role,
      iat: now,
      exp: now + 900,
      iss: 'campus-api',
      aud: 'campus',
    });
    const signature = createHmac('sha256', SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url');
    return `${header}.${payload}.${signature}`;
  };

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule, SessionModule, CohortRoleModule],
      controllers: [
        ProfessorGuardController,
        MentorGuardController,
        CombinedGuardController,
        MissingParamController,
      ],
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
  });

  const insertUser = async (email: string, systemRole = SystemRole.User) => {
    const [row] = await db
      .insert(users)
      .values({ email, systemRole })
      .returning();
    return row;
  };

  const insertCohort = async (code: string) => {
    const [row] = await db
      .insert(schema.cohorts)
      .values({ name: `Cohort ${code}`, code })
      .returning();
    return row;
  };

  const insertTrack = async (code: string) => {
    const [row] = await db
      .insert(schema.tracks)
      .values({ name: `Track ${code}`, code })
      .returning();
    return row;
  };

  const linkTrack = async (cohortId: string, trackId: string) => {
    const [row] = await db
      .insert(schema.cohortTracks)
      .values({ cohortId, trackId })
      .returning();
    return row;
  };

  const insertMember = async (
    cohortId: string,
    userId: string,
    role: CohortRole,
    options: {
      cohortTrackId?: string;
      leftAt?: Date;
      accessExpiresAt?: Date;
    } = {},
  ) => {
    const [row] = await db
      .insert(schema.cohortMembers)
      .values({
        cohortId,
        userId,
        role,
        cohortTrackId: options.cohortTrackId ?? null,
        status: role === CohortRole.Student ? StudentStatus.Active : null,
        leftAt: options.leftAt ?? null,
        accessExpiresAt: options.accessExpiresAt ?? null,
      })
      .returning();
    return row;
  };

  const insertGroup = async (
    cohortId: string,
    mentorMemberId: string,
    name: string,
  ) => {
    const [row] = await db
      .insert(schema.mentorshipGroups)
      .values({ cohortId, mentorMemberId, name })
      .returning();
    return row;
  };

  /**
   * Two cohorts, three tracks and one membership per case under test. Roles
   * are real cohort_members rows, so the guards are answering from the same
   * tables the API writes.
   */
  const world = async () => {
    const c1 = await insertCohort('C1');
    const c2 = await insertCohort('C2');
    const t1 = await insertTrack('T1');
    const t2 = await insertTrack('T2');
    const t3 = await insertTrack('T3');
    const ct1 = await linkTrack(c1.id, t1.id);
    const ct2 = await linkTrack(c1.id, t2.id);
    const ct1Other = await linkTrack(c2.id, t1.id);
    const ct2Other = await linkTrack(c2.id, t2.id);

    const admin = await insertUser('admin@campus.local', SystemRole.Admin);
    const professor1 = await insertUser('professor1@campus.local');
    const professor2 = await insertUser('professor2@campus.local');
    const professorOtherCohort = await insertUser(
      'professor-other-cohort@campus.local',
    );
    const professorEnded = await insertUser('professor-ended@campus.local');
    const student1 = await insertUser('student1@campus.local');
    const mentor1 = await insertUser('mentor1@campus.local');
    const mentor2 = await insertUser('mentor2@campus.local');
    const mentorEnded = await insertUser('mentor-ended@campus.local');
    const mentorOtherCohort = await insertUser(
      'mentor-other-cohort@campus.local',
    );
    const guest1 = await insertUser('guest1@campus.local');
    const outsider = await insertUser('outsider@campus.local');
    const dual = await insertUser('dual@campus.local');

    const professor1Member = await insertMember(
      c1.id,
      professor1.id,
      CohortRole.Professor,
      { cohortTrackId: ct1.id },
    );
    await insertMember(c1.id, professor2.id, CohortRole.Professor, {
      cohortTrackId: ct2.id,
    });
    await insertMember(c2.id, professorOtherCohort.id, CohortRole.Professor, {
      cohortTrackId: ct1Other.id,
    });
    await insertMember(c1.id, professorEnded.id, CohortRole.Professor, {
      cohortTrackId: ct1.id,
      leftAt: new Date('2020-01-01T00:00:00Z'),
    });
    await insertMember(c1.id, student1.id, CohortRole.Student, {
      cohortTrackId: ct1.id,
    });
    const mentor1Member = await insertMember(
      c1.id,
      mentor1.id,
      CohortRole.Mentor,
    );
    const mentor2Member = await insertMember(
      c1.id,
      mentor2.id,
      CohortRole.Mentor,
    );
    const mentorEndedMember = await insertMember(
      c1.id,
      mentorEnded.id,
      CohortRole.Mentor,
      { leftAt: new Date('2020-01-01T00:00:00Z') },
    );
    const mentorOtherCohortMember = await insertMember(
      c2.id,
      mentorOtherCohort.id,
      CohortRole.Mentor,
    );
    await insertMember(c1.id, guest1.id, CohortRole.Guest, {
      accessExpiresAt: new Date('2099-01-01T00:00:00Z'),
    });
    await insertMember(c1.id, dual.id, CohortRole.Professor, {
      cohortTrackId: ct1.id,
    });
    await insertMember(c2.id, dual.id, CohortRole.Student, {
      cohortTrackId: ct2Other.id,
    });

    const group1 = await insertGroup(c1.id, mentor1Member.id, 'Pod A');
    const group2 = await insertGroup(c1.id, mentor2Member.id, 'Pod B');
    const groupEnded = await insertGroup(
      c1.id,
      mentorEndedMember.id,
      'Pod Ended',
    );
    const groupOther = await insertGroup(
      c2.id,
      mentorOtherCohortMember.id,
      'Pod Other',
    );

    return {
      c1,
      c2,
      t1,
      t2,
      t3,
      ct1,
      ct2,
      ct1Other,
      ct2Other,
      members: {
        professor1: professor1Member,
        mentor1: mentor1Member,
        mentor2: mentor2Member,
        mentorEnded: mentorEndedMember,
        mentorOtherCohort: mentorOtherCohortMember,
      },
      group1,
      group2,
      groupEnded,
      groupOther,
      student1,
      cookies: {
        admin: await cookieFor(admin),
        professor1: await cookieFor(professor1),
        professor2: await cookieFor(professor2),
        professorOtherCohort: await cookieFor(professorOtherCohort),
        professorEnded: await cookieFor(professorEnded),
        student1: await cookieFor(student1),
        mentor1: await cookieFor(mentor1),
        mentorEnded: await cookieFor(mentorEnded),
        mentorOtherCohort: await cookieFor(mentorOtherCohort),
        guest1: await cookieFor(guest1),
        outsider: await cookieFor(outsider),
        dual: await cookieFor(dual),
      },
    };
  };

  const professorPath = (cohortId: string, trackId: string) =>
    `/v1/test-guards/professor/${cohortId}/tracks/${trackId}`;
  const mentorPath = (cohortId: string, groupId: string) =>
    `/v1/test-guards/mentor/${cohortId}/groups/${groupId}`;
  const combinedPath = (cohortId: string, trackId: string, groupId: string) =>
    `/v1/test-guards/professor-or-mentor/${cohortId}/tracks/${trackId}/groups/${groupId}`;

  const expectForbidden = (res: Response): void => {
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  };

  describe('ProfessorOfTrackGuard', () => {
    it('allows a professor of this track in this cohort', async () => {
      const w = await world();
      const res = await as(w.cookies.professor1)
        .get(professorPath(w.c1.id, w.t1.id))
        .expect(200);

      expect(res.body).toMatchObject({
        id: w.members.professor1.id,
        cohortId: w.c1.id,
        role: CohortRole.Professor,
        cohortTrackId: w.ct1.id,
        mentorshipGroupId: null,
      });
    });

    it('refuses a professor of a different track in the same cohort', async () => {
      const w = await world();
      expectForbidden(
        await as(w.cookies.professor1).get(professorPath(w.c1.id, w.t2.id)),
      );
    });

    it('refuses the same track id when the professor is in a different cohort', async () => {
      const w = await world();
      expectForbidden(
        await as(w.cookies.professorOtherCohort).get(
          professorPath(w.c1.id, w.t1.id),
        ),
      );
    });

    it('refuses a track the cohort does not run', async () => {
      const w = await world();
      expectForbidden(
        await as(w.cookies.professor1).get(professorPath(w.c1.id, w.t3.id)),
      );
    });

    it('refuses a professor whose membership has ended', async () => {
      const w = await world();
      expectForbidden(
        await as(w.cookies.professorEnded).get(professorPath(w.c1.id, w.t1.id)),
      );
    });

    it.each(['student1', 'mentor1', 'guest1'] as const)(
      'refuses a %s in the same cohort',
      async (caller) => {
        const w = await world();
        expectForbidden(
          await as(w.cookies[caller]).get(professorPath(w.c1.id, w.t1.id)),
        );
      },
    );

    it('refuses someone who is not a member of the cohort at all', async () => {
      const w = await world();
      expectForbidden(
        await as(w.cookies.outsider).get(professorPath(w.c1.id, w.t1.id)),
      );
    });

    it('lets an admin through without a membership', async () => {
      const w = await world();
      const res = await as(w.cookies.admin)
        .get(professorPath(w.c1.id, w.t1.id))
        .expect(200);
      expect(res.body).toEqual({});
    });

    it('refuses a cohort or track that does not exist', async () => {
      const w = await world();
      expectForbidden(
        await as(w.cookies.professor1).get(professorPath(MISSING, w.t1.id)),
      );
      expectForbidden(
        await as(w.cookies.professor1).get(professorPath(w.c1.id, MISSING)),
      );
    });

    it('refuses a malformed UUID with a validation error', async () => {
      const w = await world();
      const res = await as(w.cookies.professor1)
        .get(professorPath('not-a-uuid', w.t1.id))
        .expect(400);
      expect(res.body.error.code).toBe('INVALID_ARGUMENT');
    });

    it('refuses a route that does not supply the id it needs', async () => {
      const w = await world();
      const res = await as(w.cookies.professor1)
        .get(`/v1/test-guards/missing/${w.c1.id}/only`)
        .expect(400);
      expect(res.body.error.code).toBe('INVALID_ARGUMENT');
    });

    it('allows the professor cohort and refuses the same caller where they are a student', async () => {
      const w = await world();
      await as(w.cookies.dual).get(professorPath(w.c1.id, w.t1.id)).expect(200);
      expectForbidden(
        await as(w.cookies.dual).get(professorPath(w.c2.id, w.t2.id)),
      );
    });

    it('reads the role fresh on every request', async () => {
      const w = await world();
      await as(w.cookies.professor1)
        .get(professorPath(w.c1.id, w.t1.id))
        .expect(200);

      await db
        .update(schema.cohortMembers)
        .set({ leftAt: new Date() })
        .where(eq(schema.cohortMembers.id, w.members.professor1.id));

      expectForbidden(
        await as(w.cookies.professor1).get(professorPath(w.c1.id, w.t1.id)),
      );
    });

    it('does not grant access from a role in the body', async () => {
      const w = await world();
      expectForbidden(
        await as(w.cookies.student1).post(professorPath(w.c1.id, w.t1.id), {
          role: CohortRole.Professor,
          cohortRole: CohortRole.Professor,
        }),
      );
    });
  });

  describe('MentorOfGroupGuard', () => {
    it('allows the mentor of this group', async () => {
      const w = await world();
      const res = await as(w.cookies.mentor1)
        .get(mentorPath(w.c1.id, w.group1.id))
        .expect(200);

      expect(res.body).toMatchObject({
        id: w.members.mentor1.id,
        cohortId: w.c1.id,
        role: CohortRole.Mentor,
        mentorshipGroupId: w.group1.id,
      });
    });

    it('refuses a mentor of a different group in the same cohort', async () => {
      const w = await world();
      expectForbidden(
        await as(w.cookies.mentor1).get(mentorPath(w.c1.id, w.group2.id)),
      );
    });

    it('refuses a mentor of a group in a different cohort', async () => {
      const w = await world();
      expectForbidden(
        await as(w.cookies.mentorOtherCohort).get(
          mentorPath(w.c1.id, w.group1.id),
        ),
      );
    });

    it('refuses a group that belongs to a different cohort', async () => {
      const w = await world();
      expectForbidden(
        await as(w.cookies.mentorOtherCohort).get(
          mentorPath(w.c1.id, w.groupOther.id),
        ),
      );
    });

    it('refuses a mentor whose membership has ended', async () => {
      const w = await world();
      expectForbidden(
        await as(w.cookies.mentorEnded).get(
          mentorPath(w.c1.id, w.groupEnded.id),
        ),
      );
    });

    it.each(['student1', 'guest1'] as const)('refuses a %s', async (caller) => {
      const w = await world();
      expectForbidden(
        await as(w.cookies[caller]).get(mentorPath(w.c1.id, w.group1.id)),
      );
    });

    it('refuses a group that does not exist', async () => {
      const w = await world();
      expectForbidden(
        await as(w.cookies.mentor1).get(mentorPath(w.c1.id, MISSING)),
      );
    });

    it('lets an admin through without a membership', async () => {
      const w = await world();
      const res = await as(w.cookies.admin)
        .get(mentorPath(w.c1.id, w.group1.id))
        .expect(200);
      expect(res.body).toEqual({});
    });
  });

  describe('ProfessorOfTrackOrMentorOfGroupGuard', () => {
    it('allows a professor of the track', async () => {
      const w = await world();
      await as(w.cookies.professor1)
        .get(combinedPath(w.c1.id, w.t1.id, w.group1.id))
        .expect(200);
    });

    it('allows a mentor of the group even when the track does not match', async () => {
      const w = await world();
      const res = await as(w.cookies.mentor1)
        .get(combinedPath(w.c1.id, w.t2.id, w.group1.id))
        .expect(200);
      expect(res.body).toMatchObject({
        role: CohortRole.Mentor,
        mentorshipGroupId: w.group1.id,
      });
    });

    it('refuses a caller holding neither role', async () => {
      const w = await world();
      expectForbidden(
        await as(w.cookies.student1).get(
          combinedPath(w.c1.id, w.t1.id, w.group1.id),
        ),
      );
    });
  });

  describe('cross-cutting', () => {
    it('answers 401 rather than 403 when there is no session', async () => {
      const w = await world();
      const professor = await request(app.getHttpServer())
        .get(professorPath(w.c1.id, w.t1.id))
        .expect(401);
      expect(professor.body.error.code).toBe('UNAUTHORIZED');

      const mentor = await request(app.getHttpServer())
        .get(mentorPath(w.c1.id, w.group1.id))
        .expect(401);
      expect(mentor.body.error.code).toBe('UNAUTHORIZED');
    });

    it('does not grant access from a role claim in the token', async () => {
      const w = await world();
      const token = tokenClaimingRole(w.student1, CohortRole.Professor);

      expectForbidden(
        await request(app.getHttpServer())
          .get(professorPath(w.c1.id, w.t1.id))
          .set('Cookie', `${SESSION_COOKIE}=${token}`),
      );
    });
  });
});
