import { PGlite } from '@electric-sql/pglite';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
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
  type EmailSender,
  type OutgoingEmail,
  type SendResult,
} from './../src/infra/email/email-sender.js';
import { SESSION_COOKIE } from './../src/modules/auth/session-cookie.js';
import { SessionScope, signSessionToken } from '@campus/session';
import {
  CohortRole,
  cohortTracks,
  cohorts,
} from './../src/modules/cohorts/schema.js';
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
const SECRET = 'an-e2e-session-secret-of-at-least-32-chars';
const db = drizzle(new PGlite(), { schema });

/** Stands in for Resend: records what would have gone out. */
class RecordingSender implements EmailSender {
  enabled = true;
  sent: OutgoingEmail[] = [];
  answer: () => Promise<SendResult> = () =>
    Promise.resolve({ ok: true, id: 'em_1' });

  send(email: OutgoingEmail): Promise<SendResult> {
    this.sent.push(email);
    return this.answer();
  }
}

/**
 * Creating an invite emails its link to the invitee — and whatever the email
 * does, the invite stands, because the admin can still share the link.
 */
describe('invite email on POST /v1/invites (e2e)', () => {
  let app: INestApplication<App>;
  let adminCookie: string;
  let cohortId: string;
  let cohortTrackId: string;
  const sender = new RecordingSender();

  const createInvite = () =>
    request(app.getHttpServer())
      .post('/v1/invites')
      .set('Cookie', adminCookie)
      .set('Origin', 'http://localhost:3000')
      .send({
        email: 'ada@campus.local',
        cohortId,
        cohortRole: CohortRole.Student,
        cohortTrackId,
      });

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
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate invites, cohort_tracks, cohorts, tracks, users cascade`,
    );
    sender.sent = [];
    sender.enabled = true;
    sender.answer = () => Promise.resolve({ ok: true, id: 'em_1' });

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
    cohortId = cohort.id;
    cohortTrackId = link.id;

    const { token } = await signSessionToken(
      { userId: admin.id, email: admin.email, scope: SessionScope.FullAccess },
      { secret: SECRET, ttlMinutes: 15 },
    );
    adminCookie = `${SESSION_COOKIE}=${token}`;
  });

  it('emails the link to the invitee and says it was sent', async () => {
    const res = await createInvite();

    expect(res.status).toBe(201);
    expect(res.body.emailStatus).toBe('sent');
    expect(sender.sent).toHaveLength(1);
    const [email] = sender.sent;
    expect(email).toMatchObject({
      to: 'ada@campus.local',
      subject:
        'Jerry Smith invited you to Product Design 2026 on Campus by Rise',
      idempotencyKey: `invite/${res.body.id}`,
    });
    expect(email.text).toContain(res.body.inviteLink);
    expect(email.html).toContain(res.body.inviteLink);
  });

  it('keeps the invite when the send is refused, and says so', async () => {
    sender.answer = () =>
      Promise.resolve({ ok: false, reason: 'domain not verified' });

    const res = await createInvite();

    expect(res.status).toBe(201);
    expect(res.body.emailStatus).toBe('failed');
    expect(res.body.inviteLink).toBeDefined();
    expect(await db.select().from(invites)).toHaveLength(1);
  });

  it('sends nothing, and says so, when email is switched off', async () => {
    sender.enabled = false;

    const res = await createInvite();

    expect(res.status).toBe(201);
    expect(res.body.emailStatus).toBe('disabled');
    expect(sender.sent).toHaveLength(0);
  });

  it('sends nothing for an invite that was refused', async () => {
    await createInvite();
    sender.sent = [];

    const res = await createInvite();

    expect(res.status).toBe(409);
    expect(sender.sent).toHaveLength(0);
  });
});

describe('the email sender with FF_EMAIL_ENABLED off (e2e)', () => {
  it('is the disabled sender', async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DRIZZLE)
      .useValue({})
      .compile();

    expect(moduleFixture.get(EMAIL_SENDER)).toBe(disabledEmailSender);
    await moduleFixture.close();
  });
});
