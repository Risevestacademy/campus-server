import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import type { PinoLogger } from 'nestjs-pino';

import type { Env } from '../../infra/config/config.module.js';
import { users } from '../users/schema.js';
import type { AccessTokenCache } from './access-token-cache.js';
import {
  CHANNEL_TTL_MS,
  CalendarChannelsService,
  RENEW_BEFORE_MS,
} from './calendar-channels.service.js';
import type { CalendarGrant } from './calendar-grants.service.js';
import { GoogleCalendarApi } from './google-calendar-api.js';
import { googleCalendarChannels, googleCalendarGrants } from './schema.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);
const db = drizzle(new PGlite());
const WEBHOOK = 'https://api.campus.test/v1/calendar/notifications';
const NOW = new Date('2026-11-09T08:00:00Z');

const logger = { warn: vi.fn(), error: vi.fn(), setContext: vi.fn() };
const tokens = { get: vi.fn(), evict: vi.fn() };
const fetch = vi.fn();
const channels = (address: string | null = WEBHOOK) =>
  new CalendarChannelsService(
    db as never,
    { GOOGLE_CALENDAR_WEBHOOK_URL: address ?? undefined } as Env,
    new GoogleCalendarApi(
      tokens as unknown as AccessTokenCache,
      fetch,
      logger as unknown as PinoLogger,
    ),
    logger as unknown as PinoLogger,
  );

let grant: CalendarGrant;

const answer = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });
const stored = () => db.select().from(googleCalendarChannels);
const sentBody = (call: number) =>
  JSON.parse(fetch.mock.calls[call][1].body as string) as Record<
    string,
    unknown
  >;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  vi.resetAllMocks();
  tokens.get.mockResolvedValue('access-token');
  await db.execute(sql`truncate users cascade`);
  const [user] = await db
    .insert(users)
    .values({ email: 'mentor@campus.local' })
    .returning();
  await db
    .insert(googleCalendarGrants)
    .values({ userId: user.id, sealedRefreshToken: 'sealed' });
  grant = { userId: user.id, refreshToken: 'refresh', sealed: 'sealed' };
});

describe('ensure', () => {
  it('opens a channel to the webhook and keeps only its token’s hash', async () => {
    const expiration = NOW.getTime() + 3 * 86_400_000;
    fetch.mockResolvedValueOnce(
      answer(200, { resourceId: 'res-1', expiration: String(expiration) }),
    );

    await channels().ensure(grant, NOW);

    const body = sentBody(0);
    expect(String(fetch.mock.calls[0][0])).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/watch',
    );
    expect(body).toMatchObject({
      type: 'web_hook',
      address: WEBHOOK,
      expiration: NOW.getTime() + CHANNEL_TTL_MS,
    });
    const [row] = await stored();
    expect(row).toMatchObject({
      id: body.id,
      userId: grant.userId,
      resourceId: 'res-1',
      expiresAt: new Date(expiration),
      tokenHash: createHash('sha256')
        .update(body.token as string)
        .digest('hex'),
    });
  });

  it('leaves a channel that lasts past the renewal margin', async () => {
    await db.insert(googleCalendarChannels).values({
      id: '11111111-1111-4111-8111-111111111111',
      userId: grant.userId,
      resourceId: 'res-old',
      tokenHash: 'x'.repeat(64),
      expiresAt: new Date(NOW.getTime() + RENEW_BEFORE_MS + 1),
    });

    await channels().ensure(grant, NOW);

    expect(fetch).not.toHaveBeenCalled();
  });

  it('renews one about to lapse, then stops the old one', async () => {
    const old = '11111111-1111-4111-8111-111111111111';
    await db.insert(googleCalendarChannels).values({
      id: old,
      userId: grant.userId,
      resourceId: 'res-old',
      tokenHash: 'x'.repeat(64),
      expiresAt: new Date(NOW.getTime() + RENEW_BEFORE_MS - 1),
    });
    fetch
      .mockResolvedValueOnce(answer(200, { resourceId: 'res-new' }))
      .mockResolvedValueOnce(answer(204));

    await channels().ensure(grant, NOW);

    expect(String(fetch.mock.calls[1][0])).toBe(
      'https://www.googleapis.com/calendar/v3/channels/stop',
    );
    expect(sentBody(1)).toEqual({ id: old, resourceId: 'res-old' });
    expect((await stored()).map((c) => c.resourceId)).toEqual(['res-new']);
  });

  it('leaves standing a channel opened after its own, so two renewals at once keep one', async () => {
    const newer = '33333333-3333-4333-8333-333333333333';
    await db.insert(googleCalendarChannels).values({
      id: newer,
      userId: grant.userId,
      resourceId: 'res-newer',
      tokenHash: 'x'.repeat(64),
      expiresAt: NOW,
      createdAt: new Date(Date.now() + 3_600_000),
    });
    fetch.mockResolvedValueOnce(answer(200, { resourceId: 'res-mine' }));

    await channels().ensure(grant, NOW);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await stored()).map((c) => c.resourceId).sort()).toEqual([
      'res-mine',
      'res-newer',
    ]);
  });

  it('opens nothing without a webhook address', async () => {
    await channels(null).ensure(grant, NOW);

    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('stopAll', () => {
  it('forgets a channel Google would not stop', async () => {
    await db.insert(googleCalendarChannels).values({
      id: '11111111-1111-4111-8111-111111111111',
      userId: grant.userId,
      resourceId: 'res-old',
      tokenHash: 'x'.repeat(64),
      expiresAt: NOW,
    });
    fetch.mockResolvedValueOnce(answer(500));

    await channels().stopAll(grant);

    expect(await stored()).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('verify', () => {
  const id = '22222222-2222-4222-8222-222222222222';

  beforeEach(async () => {
    await db.insert(googleCalendarChannels).values({
      id,
      userId: grant.userId,
      resourceId: 'res',
      tokenHash: createHash('sha256').update('the-token').digest('hex'),
      expiresAt: NOW,
    });
  });

  it('names the calendar a genuine notification is about', async () => {
    await expect(channels().verify(id, 'the-token')).resolves.toBe(
      grant.userId,
    );
  });

  it.each([
    ['a wrong token', id, 'not-the-token'],
    ['no token', id, undefined],
    ['an unknown channel', '33333333-3333-4333-8333-333333333333', 'the-token'],
    ['a channel id that is not a uuid', 'nonsense', 'the-token'],
  ])('refuses %s', async (_, channelId, token) => {
    await expect(channels().verify(channelId, token)).resolves.toBeNull();
  });

  it('forgets the channels of a grant that goes', async () => {
    await db
      .delete(googleCalendarGrants)
      .where(eq(googleCalendarGrants.userId, grant.userId));

    expect(await stored()).toEqual([]);
  });
});
