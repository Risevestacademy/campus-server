import { PGlite } from '@electric-sql/pglite';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from './../src/app.module.js';
import * as schema from './../src/infra/database/schema/index.js';
import { DRIZZLE } from './../src/infra/database/database.constants.js';
import { GoogleOAuthService } from './../src/modules/auth/google-oauth.service.js';
import { SESSION_COOKIE } from './../src/modules/auth/session-cookie.js';
import { CALENDAR_FETCH } from './../src/modules/calendar/google-calendar.client.js';
import { googleCalendarGrants } from './../src/modules/calendar/schema.js';
import {
  CohortRole,
  cohortMembers,
  cohorts,
} from './../src/modules/cohorts/schema.js';
import { users } from './../src/modules/users/schema.js';
import { ValidationException } from './../src/shared/exceptions/index.js';
import {
  DomainExceptionFilter,
  GlobalExceptionFilter,
  ValidationExceptionFilter,
} from './../src/shared/filters/index.js';

const MIGRATIONS = fileURLToPath(
  new URL('../src/infra/database/migrations', import.meta.url),
);
const CALLBACK = 'http://localhost:3000/v1/calendar/connect/callback';
const CALENDAR = 'https://www.googleapis.com/auth/calendar.events.readonly';

const db = drizzle(new PGlite(), { schema });

const IDENTITY = {
  subject: 'google-sub-calendar',
  email: 'ada@campus.local',
  emailVerified: true,
  firstName: 'Ada',
  lastName: 'Lovelace',
  displayName: 'Ada Lovelace',
  avatarUrl: null,
};

/** Sign-in stands in whole; the calendar is real up to Google's endpoints. */
const signInGoogle = { verifyIdToken: vi.fn() };
const fetch = vi.fn();

let tokenAnswer: Record<string, unknown>;
let revokeStatus: number;
const revoked: string[] = [];

function idToken(sub: string): string {
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    part({ alg: 'RS256' }),
    part({
      iss: 'https://accounts.google.com',
      aud: 'e2e-client-id.apps.googleusercontent.com',
      sub,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    'signature',
  ].join('.');
}

function googleRedeems(sub: string, tokens: Record<string, unknown> = {}) {
  tokenAnswer = {
    id_token: idToken(sub),
    refresh_token: 'google-refresh',
    access_token: 'google-access',
    scope: `openid ${CALENDAR}`,
    ...tokens,
  };
}

/** Google, by endpoint. */
function google(url: string | URL, init?: RequestInit): Promise<Response> {
  const json = (status: number, body: object) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
  const form = new URLSearchParams(String(init?.body ?? ''));
  const href = String(url);
  if (href === 'https://oauth2.googleapis.com/revoke') {
    revoked.push(form.get('token') ?? '');
    return json(revokeStatus, {});
  }
  if (href === 'https://oauth2.googleapis.com/token') {
    return form.get('grant_type') === 'refresh_token'
      ? json(200, { access_token: 'google-access', expires_in: 3599 })
      : json(200, tokenAnswer);
  }
  return json(200, { items: [standup] });
}

const codeRedeemed = () =>
  new URLSearchParams(
    String((tokenRequests()[0]?.[1] as RequestInit | undefined)?.body),
  ).get('code');

const tokenRequests = () =>
  fetch.mock.calls.filter(
    ([url, init]) =>
      String(url) === 'https://oauth2.googleapis.com/token' &&
      new URLSearchParams(String((init as RequestInit).body)).get(
        'grant_type',
      ) === 'authorization_code',
  );

const standup = {
  id: 'standup_20261027',
  summary: 'Backend standup',
  start: { dateTime: '2026-10-27T10:00:00+01:00' },
  end: { dateTime: '2026-10-27T10:30:00+01:00' },
};

describe('Google Calendar (e2e)', () => {
  let app: INestApplication<App>;
  let adaId: string;

  beforeAll(async () => {
    vi.stubEnv('FF_GOOGLE_CALENDAR_ENABLED', 'true');
    vi.stubEnv('GOOGLE_CALENDAR_TOKEN_KEY', randomBytes(32).toString('base64'));
    vi.stubEnv('GOOGLE_CALENDAR_CALLBACK_URL', CALLBACK);
    await migrate(db, { migrationsFolder: MIGRATIONS });

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DRIZZLE)
      .useValue(db)
      .overrideProvider(GoogleOAuthService)
      .useValue(signInGoogle)
      .overrideProvider(CALENDAR_FETCH)
      .useValue(fetch)
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
    await app?.close();
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate users, cohorts cascade`);
    vi.clearAllMocks();
    signInGoogle.verifyIdToken.mockResolvedValue(IDENTITY);
    googleRedeems(IDENTITY.subject);
    revokeStatus = 200;
    revoked.length = 0;
    fetch.mockImplementation(google);

    const [cohort] = await db
      .insert(cohorts)
      .values({ name: 'Cohort 1', code: 'C1' })
      .returning({ id: cohorts.id });
    const [ada] = await db
      .insert(users)
      .values({ email: IDENTITY.email, providerId: IDENTITY.subject })
      .returning({ id: users.id });
    adaId = ada.id;
    await db.insert(cohortMembers).values({
      cohortId: cohort.id,
      userId: ada.id,
      role: CohortRole.Mentor,
    });
  });

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const grants = () => db.select().from(googleCalendarGrants);

  async function signIn(): Promise<string> {
    const { body } = await http()
      .post('/v1/auth/google/token')
      .send({ idToken: 'an-id-token' })
      .expect(200);
    return body.accessToken as string;
  }

  async function startConnect(token: string): Promise<URL> {
    const res = await http()
      .get('/v1/calendar/connect')
      .set(bearer(token))
      .expect(302);
    return new URL(res.headers.location);
  }

  const outcome = (res: { headers: Record<string, string> }) =>
    new URL(res.headers.location).searchParams.get('calendar');

  describe('connecting from the web', () => {
    it('sends the member to Google for read-only calendar access', async () => {
      const google = await startConnect(await signIn());

      expect(google.origin).toBe('https://accounts.google.com');
      expect(google.searchParams.get('scope')).toBe(`openid ${CALENDAR}`);
      expect(google.searchParams.get('access_type')).toBe('offline');
      expect(google.searchParams.get('login_hint')).toBe(IDENTITY.email);
      expect(google.searchParams.get('redirect_uri')).toBe(CALLBACK);
      expect(google.searchParams.has('include_granted_scopes')).toBe(false);
    });

    it('keeps the grant, and reads the calendar with it', async () => {
      const token = await signIn();
      const state = (await startConnect(token)).searchParams.get('state')!;

      const done = await http()
        .get('/v1/calendar/connect/callback')
        .query({ code: 'google-code', state })
        .set('Cookie', `${SESSION_COOKIE}=${token}`)
        .expect(302);

      expect(done.headers.location).toBe(
        'http://localhost:3000/campus?calendar=connected',
      );
      expect(codeRedeemed()).toBe('google-code');
      const [grant] = await grants();
      expect(grant.userId).toBe(adaId);
      expect(grant.sealedRefreshToken).not.toContain('google-refresh');

      const { body } = await http()
        .get('/v1/calendar/events')
        .set(bearer(token))
        .expect(200);
      expect(body).toEqual({
        connected: true,
        truncated: false,
        events: [expect.objectContaining({ id: 'standup_20261027' })],
      });
      const [, init] = fetch.mock.calls.find(([url]) =>
        String(url).startsWith('https://www.googleapis.com/calendar/'),
      ) as [URL, RequestInit];
      expect(init.headers).toEqual({ Authorization: 'Bearer google-access' });
    });

    it('refuses a state issued to somebody else, before reaching Google', async () => {
      await db.insert(users).values({
        email: 'mallory@campus.local',
        providerId: 'google-sub-mallory',
        systemRole: schema.SystemRole.Admin,
      });
      signInGoogle.verifyIdToken.mockResolvedValueOnce({
        ...IDENTITY,
        subject: 'google-sub-mallory',
        email: 'mallory@campus.local',
      });
      const malloryToken = await signIn();
      const state = (await startConnect(malloryToken)).searchParams.get(
        'state',
      )!;

      const done = await http()
        .get('/v1/calendar/connect/callback')
        .query({ code: 'adas-code', state })
        .set('Cookie', `${SESSION_COOKIE}=${await signIn()}`)
        .expect(302);

      expect(outcome(done)).toBe('invalid_state');
      expect(tokenRequests()).toHaveLength(0);
      expect(await grants()).toHaveLength(0);
    });

    it('refuses, and revokes, another Google account’s calendar', async () => {
      const token = await signIn();
      const state = (await startConnect(token)).searchParams.get('state')!;
      googleRedeems('google-sub-someone-else');

      const done = await http()
        .get('/v1/calendar/connect/callback')
        .query({ code: 'google-code', state })
        .set('Cookie', `${SESSION_COOKIE}=${token}`)
        .expect(302);

      expect(outcome(done)).toBe('wrong_account');
      expect(revoked).toEqual(['google-refresh']);
      expect(await grants()).toHaveLength(0);
    });

    it('sends a member back when they decline at Google', async () => {
      const token = await signIn();
      const state = (await startConnect(token)).searchParams.get('state')!;

      const done = await http()
        .get('/v1/calendar/connect/callback')
        .query({ error: 'access_denied', state })
        .set('Cookie', `${SESSION_COOKIE}=${token}`)
        .expect(302);

      expect(outcome(done)).toBe('denied');
    });

    it('redirects, rather than answering JSON, without a session', async () => {
      const start = await http().get('/v1/calendar/connect').expect(302);
      const callback = await http()
        .get('/v1/calendar/connect/callback?code=c&state=s')
        .expect(302);

      expect(outcome(start)).toBe('unauthorized');
      expect(outcome(callback)).toBe('unauthorized');
    });
  });

  describe('connecting from a native app', () => {
    it('keeps the grant a server auth code carries', async () => {
      const token = await signIn();

      await http()
        .post('/v1/calendar/connect')
        .set(bearer(token))
        .send({ serverAuthCode: 'server-code' })
        .expect(204);

      expect(codeRedeemed()).toBe('server-code');
      expect(await grants()).toHaveLength(1);
    });

    it('says why a code was refused', async () => {
      const token = await signIn();
      googleRedeems(IDENTITY.subject, { scope: 'openid' });

      const { body } = await http()
        .post('/v1/calendar/connect')
        .set(bearer(token))
        .send({ serverAuthCode: 'server-code' })
        .expect(400);

      expect(body.error.details).toEqual({ reason: 'not_granted' });
      expect(await grants()).toHaveLength(0);
    });
  });

  describe('reading and disconnecting', () => {
    async function connected(): Promise<string> {
      const token = await signIn();
      await http()
        .post('/v1/calendar/connect')
        .set(bearer(token))
        .send({ serverAuthCode: 'server-code' })
        .expect(204);
      return token;
    }

    it('answers not connected to a member who has not connected', async () => {
      const { body } = await http()
        .get('/v1/calendar/events')
        .set(bearer(await signIn()))
        .expect(200);

      expect(body).toEqual({ connected: false, events: [], truncated: false });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('refuses a window it will not read', async () => {
      const { body } = await http()
        .get('/v1/calendar/events')
        .query({ from: 'tomorrow' })
        .set(bearer(await signIn()))
        .expect(400);

      expect(body.error.code).toBe('INVALID_ARGUMENT');
    });

    it('revokes the grant on disconnect, then forgets it', async () => {
      const token = await connected();

      await http().delete('/v1/calendar').set(bearer(token)).expect(204);

      expect(revoked).toEqual(['google-refresh']);
      expect(await grants()).toHaveLength(0);
    });

    it('keeps a grant Google would not revoke, unused, to try again', async () => {
      const token = await connected();
      revokeStatus = 503;

      await http().delete('/v1/calendar').set(bearer(token)).expect(204);

      const [grant] = await grants();
      expect(grant.revokeRequestedAt).toBeInstanceOf(Date);
      const { body } = await http()
        .get('/v1/calendar/events')
        .set(bearer(token))
        .expect(200);
      expect(body.connected).toBe(false);
    });

    it('is for signed-in members only', async () => {
      await http().get('/v1/calendar/events').expect(401);
      await http().post('/v1/calendar/connect').expect(401);
      await http().delete('/v1/calendar').expect(401);
    });
  });
});
