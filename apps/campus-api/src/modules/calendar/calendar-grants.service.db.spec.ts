import { PGlite } from '@electric-sql/pglite';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import type { PinoLogger } from 'nestjs-pino';

import type { Env } from '../../infra/config/config.module.js';
import { CohortRole, cohortMembers, cohorts } from '../cohorts/schema.js';
import { SystemRole, UserStatus, users } from '../users/schema.js';
import { CalendarGrantsService } from './calendar-grants.service.js';
import { googleCalendarGrants } from './schema.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);
const db = drizzle(new PGlite(), {
  schema: { users, cohorts, cohortMembers, googleCalendarGrants },
});

const KEY = randomBytes(32);
const config = (overrides: Partial<Env> = {}) =>
  ({
    FF_GOOGLE_AUTH_ENABLED: true,
    FF_GOOGLE_CALENDAR_ENABLED: true,
    GOOGLE_CLIENT_ID: 'web-client',
    GOOGLE_CLIENT_SECRET: 'web-secret',
    GOOGLE_CALENDAR_CALLBACK_URL:
      'http://localhost/v1/calendar/connect/callback',
    AUTH_STATE_SECRET: 'a-state-secret-of-at-least-32-characters',
    GOOGLE_CALENDAR_TOKEN_KEY: KEY.toString('base64'),
    ...overrides,
  }) as Env;

const logger = { info: vi.fn(), error: vi.fn(), setContext: vi.fn() };
const service = (overrides: Partial<Env> = {}) =>
  new CalendarGrantsService(
    db as never,
    config(overrides),
    logger as unknown as PinoLogger,
  );
const grants = service();

const NOW = new Date('2026-10-25T12:00:00Z');
const DAY = 86_400_000;

let cohortId: string;

async function person(
  email: string,
  overrides: Partial<typeof users.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email, ...overrides })
    .returning();
  return row.id;
}

async function member(
  userId: string,
  overrides: Partial<typeof cohortMembers.$inferInsert> = {},
): Promise<void> {
  await db
    .insert(cohortMembers)
    .values({ cohortId, userId, role: CohortRole.Mentor, ...overrides });
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  vi.clearAllMocks();
  await db.execute(sql`truncate users, cohorts cascade`);
  const [cohort] = await db
    .insert(cohorts)
    .values({ name: 'Cohort 1', code: 'C1' })
    .returning();
  cohortId = cohort.id;
});

describe('CalendarGrantsService', () => {
  let ada: string;

  beforeEach(async () => {
    ada = await person('ada@campus.local');
  });

  it('keeps the token sealed, and opens it again', async () => {
    await grants.save(ada, '1//google-refresh');

    const [row] = await db.select().from(googleCalendarGrants);
    expect(row.sealedRefreshToken).not.toContain('google-refresh');
    await expect(grants.find(ada)).resolves.toMatchObject({
      userId: ada,
      refreshToken: '1//google-refresh',
    });
  });

  it('holds one grant per member, the latest', async () => {
    await grants.save(ada, 'first');
    await grants.save(ada, 'second');

    expect(await db.select().from(googleCalendarGrants)).toHaveLength(1);
    await expect(grants.find(ada)).resolves.toMatchObject({
      refreshToken: 'second',
    });
  });

  it('finds nothing for a member who never connected', async () => {
    await expect(grants.find(ada)).resolves.toBeNull();
  });

  it('forgets the grant it read, not one saved since', async () => {
    await grants.save(ada, 'first');
    const read = await grants.find(ada);
    await grants.save(ada, 'second');

    await grants.forget(read!);

    await expect(grants.find(ada)).resolves.toMatchObject({
      refreshToken: 'second',
    });
  });

  it('keeps, but does not use, a grant sealed with another key', async () => {
    await grants.save(ada, 'token');
    const rotated = service({
      GOOGLE_CALENDAR_TOKEN_KEY: randomBytes(32).toString('base64'),
    });

    await expect(rotated.find(ada)).resolves.toBeNull();
    expect(logger.error).toHaveBeenCalled();
    expect(await db.select().from(googleCalendarGrants)).toHaveLength(1);
  });

  it('goes with the account', async () => {
    await grants.save(ada, 'token');

    await db.delete(users);

    expect(await db.select().from(googleCalendarGrants)).toHaveLength(0);
  });

  describe('revocation', () => {
    it('stops using a grant once its revocation is asked for', async () => {
      await grants.save(ada, 'token');

      await grants.requestRevocation(ada, NOW);

      await expect(grants.find(ada)).resolves.toBeNull();
      await expect(grants.pendingRevocations()).resolves.toEqual([
        expect.objectContaining({ userId: ada, refreshToken: 'token' }),
      ]);
    });

    it('keeps the row until the revocation is confirmed', async () => {
      await grants.save(ada, 'token');
      await grants.requestRevocation(ada, NOW);
      const [pending] = await grants.pendingRevocations(ada);

      expect(await db.select().from(googleCalendarGrants)).toHaveLength(1);
      await grants.removeRevoked(pending);

      expect(await db.select().from(googleCalendarGrants)).toHaveLength(0);
    });

    it('takes back a pending revocation when the member reconnects', async () => {
      await grants.save(ada, 'old');
      await grants.requestRevocation(ada, NOW);
      const [pending] = await grants.pendingRevocations(ada);

      await grants.save(ada, 'new');
      await grants.removeRevoked(pending);

      await expect(grants.pendingRevocations()).resolves.toEqual([]);
      await expect(grants.find(ada)).resolves.toMatchObject({
        refreshToken: 'new',
      });
    });

    it('hands out pending revocations oldest first, for one member or all', async () => {
      const bo = await person('bo@campus.local');
      await grants.save(ada, 'ada-token');
      await grants.save(bo, 'bo-token');
      await grants.requestRevocation(bo, new Date(NOW.getTime() - DAY));
      await grants.requestRevocation(ada, NOW);

      expect(
        (await grants.pendingRevocations()).map((p) => p.refreshToken),
      ).toEqual(['bo-token', 'ada-token']);
      expect(
        (await grants.pendingRevocations(ada)).map((p) => p.refreshToken),
      ).toEqual(['ada-token']);
    });

    it('revokes while the calendar is switched off', async () => {
      await grants.save(ada, 'token');
      const off = service({ FF_GOOGLE_CALENDAR_ENABLED: false });

      await off.requestRevocation(ada, NOW);

      await expect(off.pendingRevocations()).resolves.toEqual([
        expect.objectContaining({ refreshToken: 'token' }),
      ]);
    });

    it('waits, still marked, while the key is not configured', async () => {
      await grants.save(ada, 'token');
      const keyless = service({
        FF_GOOGLE_CALENDAR_ENABLED: false,
        GOOGLE_CALENDAR_TOKEN_KEY: undefined,
      });

      await keyless.requestRevocation(ada, NOW);

      await expect(keyless.pendingRevocations()).resolves.toEqual([]);
      await expect(grants.pendingRevocations()).resolves.toHaveLength(1);
    });

    it('hands out a grant sealed with another key with no token', async () => {
      await grants.save(ada, 'token');
      await grants.requestRevocation(ada, NOW);

      await expect(
        service({
          GOOGLE_CALENDAR_TOKEN_KEY: randomBytes(32).toString('base64'),
        }).pendingRevocations(),
      ).resolves.toEqual([
        expect.objectContaining({ userId: ada, refreshToken: null }),
      ]);
    });
  });
});

describe('requestLapsedRevocations', () => {
  async function connected(
    email: string,
    overrides: Partial<typeof users.$inferInsert> = {},
  ): Promise<string> {
    const id = await person(email, overrides);
    await grants.save(id, `token-of-${email}`);
    return id;
  }

  const pendingTokens = async () =>
    (await grants.pendingRevocations()).map((p) => p.refreshToken).sort();

  it('leaves the grants of members and admins alone', async () => {
    const mentor = await connected('mentor@campus.local');
    await member(mentor);
    const guest = await connected('guest@campus.local');
    await member(guest, {
      role: CohortRole.Guest,
      accessExpiresAt: new Date(NOW.getTime() + DAY),
    });
    await connected('admin@campus.local', { systemRole: SystemRole.Admin });

    await expect(grants.requestLapsedRevocations(NOW)).resolves.toBe(0);
    await expect(pendingTokens()).resolves.toEqual([]);
    await expect(grants.find(mentor)).resolves.not.toBeNull();
  });

  it('marks the grants of people whose access has ended', async () => {
    const left = await connected('left@campus.local');
    await member(left, { leftAt: new Date(NOW.getTime() - DAY) });
    const visited = await connected('visited@campus.local');
    await member(visited, {
      role: CohortRole.Guest,
      accessExpiresAt: new Date(NOW.getTime() - DAY),
    });
    await connected('never@campus.local');
    await connected('suspended@campus.local', {
      systemRole: SystemRole.Admin,
      status: UserStatus.Suspended,
    });
    const stays = await connected('stays@campus.local');
    await member(stays);

    await expect(grants.requestLapsedRevocations(NOW)).resolves.toBe(4);

    await expect(pendingTokens()).resolves.toEqual(
      [
        'token-of-left@campus.local',
        'token-of-never@campus.local',
        'token-of-suspended@campus.local',
        'token-of-visited@campus.local',
      ].sort(),
    );
    await expect(grants.find(left)).resolves.toBeNull();
    await expect(grants.find(stays)).resolves.not.toBeNull();
  });

  it('marks a suspended member, though their membership is live', async () => {
    const suspended = await connected('suspended@campus.local', {
      status: UserStatus.Suspended,
    });
    await member(suspended);

    await expect(grants.requestLapsedRevocations(NOW)).resolves.toBe(1);
  });

  it('marks each grant once', async () => {
    await connected('never@campus.local');

    await grants.requestLapsedRevocations(NOW);

    await expect(grants.requestLapsedRevocations(NOW)).resolves.toBe(0);
  });
});
