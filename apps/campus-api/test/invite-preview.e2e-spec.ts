import { PGlite } from '@electric-sql/pglite';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
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
  CohortRole,
  cohortTracks,
  cohorts,
} from './../src/modules/cohorts/schema.js';
import {
  generateInviteToken,
  hashInviteToken,
} from './../src/modules/invites/invite-token.js';
import { InviteStatus, invites } from './../src/modules/invites/schema.js';
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
 * The invitation screen is the first thing an invitee sees, before any
 * sign-in, so this is the one invite read that has no session behind it —
 * only the token from the link.
 */
describe('POST /v1/invites/preview (e2e)', () => {
  let app: INestApplication<App>;
  let inviterId: string;
  let cohortId: string;
  let cohortTrackId: string;

  const preview = (token: unknown) =>
    request(app.getHttpServer()).post('/v1/invites/preview').send({ token });

  /** A student invite, returning the raw token the link would carry. */
  const makeInvite = async (
    overrides: Partial<typeof invites.$inferInsert> = {},
  ) => {
    const token = generateInviteToken();
    const [row] = await db
      .insert(invites)
      .values({
        email: 'ada@campus.local',
        invitedBy: inviterId,
        tokenHash: hashInviteToken(token),
        cohortId,
        cohortRole: CohortRole.Student,
        cohortTrackId,
        expiresAt: new Date(Date.now() + 86_400_000),
        ...overrides,
      })
      .returning();
    return { token, row };
  };

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DRIZZLE)
      .useValue(db)
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
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate invites, cohort_tracks, cohorts, tracks, users cascade`,
    );
    const [admin] = await db
      .insert(users)
      .values({
        email: 'jerry@campus.local',
        firstName: 'Jerry',
        lastName: 'Smith',
        systemRole: SystemRole.Admin,
      })
      .returning();
    const [track] = await db
      .insert(tracks)
      .values({ name: 'Product Design', code: 'PD' })
      .returning();
    const [cohort] = await db
      .insert(cohorts)
      .values({ name: 'Product Design 2026', code: 'PD26' })
      .returning();
    const [link] = await db
      .insert(cohortTracks)
      .values({ cohortId: cohort.id, trackId: track.id })
      .returning();
    inviterId = admin.id;
    cohortId = cohort.id;
    cohortTrackId = link.id;
  });

  it('shows the offer to whoever holds the link, with no session', async () => {
    const { token } = await makeInvite();

    const res = await preview(token);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      email: 'ada@campus.local',
      cohort: {
        name: 'Product Design 2026',
        code: 'PD26',
        startDate: null,
        endDate: null,
      },
      track: { name: 'Product Design', code: 'PD' },
      cohortRole: CohortRole.Student,
      systemRole: SystemRole.User,
      invitedBy: { firstName: 'Jerry', lastName: 'Smith' },
      expiresAt: expect.any(String),
      guestAccessExpiresAt: null,
    });
  });

  it('shows an admin invite with no cohort or track', async () => {
    const { token } = await makeInvite({
      cohortId: null,
      cohortRole: null,
      cohortTrackId: null,
      systemRole: SystemRole.Admin,
    });

    const res = await preview(token);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      cohort: null,
      track: null,
      cohortRole: null,
      systemRole: SystemRole.Admin,
    });
  });

  it('answers 404 for a token that matches nothing', async () => {
    await makeInvite();

    const res = await preview(generateInviteToken());

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('answers 403 for a lapsed invite, and records it as expired', async () => {
    const { token, row } = await makeInvite({
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await preview(token);

    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('This invite has expired');
    const [after] = await db
      .select()
      .from(invites)
      .where(eq(invites.id, row.id));
    expect(after.status).toBe(InviteStatus.Expired);
  });

  it.each([
    [InviteStatus.Accepted, 'INVITE_ALREADY_ACCEPTED'],
    [InviteStatus.Declined, 'INVITE_ALREADY_DECLINED'],
    [InviteStatus.Revoked, 'INVITE_REVOKED'],
  ])('answers 409 %s for an invite already settled', async (status, code) => {
    const { token } = await makeInvite({ status });

    const res = await preview(token);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(code);
  });

  it('refuses a request with no token, and says that is why', async () => {
    for (const token of [undefined, '']) {
      const res = await preview(token);
      expect(res.status).toBe(400);
      expect(res.body.error.details.fields.token).toBe(
        'token should not be empty',
      );
    }
  });
});
