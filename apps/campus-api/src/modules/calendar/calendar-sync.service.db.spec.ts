import { PGlite } from '@electric-sql/pglite';
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import type { PinoLogger } from 'nestjs-pino';

import type { Env } from '../../infra/config/config.module.js';
import { CohortRole, cohortMembers, cohorts } from '../cohorts/schema.js';
import { AudioMode, SpaceAccess, maps, spaces } from '../maps/schema.js';
import { roomLinkInstances, roomLinks } from '../room-links/schema.js';
import { SystemRole, users } from '../users/schema.js';
import type { AccessTokenCache } from './access-token-cache.js';
import { CalendarGrantsService } from './calendar-grants.service.js';
import { CalendarSyncService } from './calendar-sync.service.js';
import { GoogleCalendarApi } from './google-calendar-api.js';
import type { GoogleEvent } from './google-event.js';
import { googleCalendarGrants } from './schema.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);
const db = drizzle(new PGlite());

const APP_URL = 'https://campus.test';
const KEY = randomBytes(32);
const config = {
  APP_PUBLIC_URL: APP_URL,
  FF_GOOGLE_AUTH_ENABLED: true,
  FF_GOOGLE_CALENDAR_ENABLED: true,
  GOOGLE_CLIENT_ID: 'web-client',
  GOOGLE_CLIENT_SECRET: 'web-secret',
  GOOGLE_CALENDAR_CALLBACK_URL: 'http://localhost/v1/calendar/connect/callback',
  AUTH_STATE_SECRET: 'a-state-secret-of-at-least-32-characters',
  GOOGLE_CALENDAR_TOKEN_KEY: KEY.toString('base64'),
} as Env;

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setContext: vi.fn(),
};
const tokens = { get: vi.fn(), evict: vi.fn() };
const fetch = vi.fn();
const grants = new CalendarGrantsService(
  db as never,
  config,
  logger as unknown as PinoLogger,
);
const sync = new CalendarSyncService(
  db as never,
  config,
  grants,
  new GoogleCalendarApi(
    tokens as unknown as AccessTokenCache,
    fetch,
    logger as unknown as PinoLogger,
  ),
  tokens as unknown as AccessTokenCache,
  logger as unknown as PinoLogger,
);

const NOW = new Date('2026-11-09T08:00:00Z');
const CODE = 'k3F9xQ2pLm';
const OTHER_CODE = 'Zz9Yy8Xx7W';

let cohortId: string;
let otherCohortId: string;
let spaceId: string;
let mentorId: string;
let linkId: string;

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** Each call to Google answers with the next page given. */
function google(...pages: Response[]) {
  for (const page of pages) {
    fetch.mockResolvedValueOnce(page);
  }
}

const event = (overrides: Partial<GoogleEvent> = {}): GoogleEvent => ({
  id: 'standup_20261110T100000Z',
  status: 'confirmed',
  start: { dateTime: '2026-11-10T10:00:00Z' },
  end: { dateTime: '2026-11-10T11:00:00Z' },
  location: `${APP_URL}/join/${CODE}`,
  organizer: { self: true },
  ...overrides,
});

const instances = () =>
  db.select().from(roomLinkInstances).orderBy(roomLinkInstances.startsAt);

const grantRow = async (userId: string) =>
  (
    await db
      .select()
      .from(googleCalendarGrants)
      .where(eq(googleCalendarGrants.userId, userId))
  )[0];

const requestedUrl = (call: number) => new URL(fetch.mock.calls[call][0]);

async function person(email: string, systemRole = SystemRole.User) {
  const [row] = await db
    .insert(users)
    .values({ email, systemRole })
    .returning();
  return row.id;
}

async function link(code: string, cohort = cohortId) {
  const [row] = await db
    .insert(roomLinks)
    .values({
      code,
      cohortId: cohort,
      spaceId,
      title: 'Standup',
      createdBy: mentorId,
    })
    .returning();
  return row.id;
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  vi.resetAllMocks();
  tokens.get.mockResolvedValue('access-token');
  await db.execute(
    sql`truncate room_link_instances, room_links, spaces, maps, cohort_members, cohorts, users cascade`,
  );
  [{ id: cohortId }] = await db
    .insert(cohorts)
    .values({ name: 'C1', code: 'C1' })
    .returning();
  [{ id: otherCohortId }] = await db
    .insert(cohorts)
    .values({ name: 'C2', code: 'C2' })
    .returning();
  const [map] = await db
    .insert(maps)
    .values({ key: 'campus', name: 'Campus', isEntry: true })
    .returning();
  [{ id: spaceId }] = await db
    .insert(spaces)
    .values({
      mapId: map.id,
      key: 'lecture',
      name: 'Lecture',
      audioMode: AudioMode.Boundary,
      access: SpaceAccess.Normal,
    })
    .returning();
  mentorId = await person('mentor@campus.local');
  await db
    .insert(cohortMembers)
    .values({ cohortId, userId: mentorId, role: CohortRole.Mentor });
  await grants.save(mentorId, 'mentor-refresh');
  linkId = await link(CODE);
});

describe('a full read', () => {
  it('keeps the organiser’s events that carry a live link, and the sync token', async () => {
    google(answer(200, { items: [event()], nextSyncToken: 'sync-1' }));

    await sync.sync(mentorId, NOW);

    expect(await instances()).toEqual([
      expect.objectContaining({
        roomLinkId: linkId,
        organizerId: mentorId,
        googleEventId: 'standup_20261110T100000Z',
        startsAt: new Date('2026-11-10T10:00:00Z'),
        endsAt: new Date('2026-11-10T11:00:00Z'),
        cancelledAt: null,
      }),
    ]);
    expect(await grantRow(mentorId)).toMatchObject({
      syncToken: 'sync-1',
      syncedAt: NOW,
      syncLeaseUntil: null,
      syncPending: false,
    });
    const url = requestedUrl(0);
    expect(url.searchParams.get('timeMin')).toBe('2026-11-08T08:00:00.000Z');
    expect(url.searchParams.get('singleEvents')).toBe('true');
    expect(url.searchParams.get('showDeleted')).toBe('true');
    expect(url.searchParams.get('syncToken')).toBeNull();
  });

  it('reads every page before applying any', async () => {
    google(
      answer(200, { items: [event()], nextPageToken: 'page-2' }),
      answer(200, {
        items: [
          event({
            id: 'standup_20261117T100000Z',
            start: { dateTime: '2026-11-17T10:00:00Z' },
            end: { dateTime: '2026-11-17T11:00:00Z' },
          }),
        ],
        nextSyncToken: 'sync-1',
      }),
    );

    await sync.sync(mentorId, NOW);

    expect(await instances()).toHaveLength(2);
    expect(requestedUrl(1).searchParams.get('pageToken')).toBe('page-2');
  });

  it.each([
    ['somebody else organised', { organizer: { self: false } }],
    ['carries no link', { location: 'Room 4', description: undefined }],
    ['carries an unknown link', { location: `${APP_URL}/join/Aa1Bb2Cc3D` }],
    [
      'lasts all day',
      { start: { date: '2026-11-10' }, end: { date: '2026-11-11' } },
    ],
    ['is cancelled', { status: 'cancelled' }],
  ])('leaves out an event that %s', async (_, overrides) => {
    google(answer(200, { items: [event(overrides)], nextSyncToken: 's' }));

    await sync.sync(mentorId, NOW);

    expect(await instances()).toEqual([]);
  });

  it('leaves out a revoked link', async () => {
    await db
      .update(roomLinks)
      .set({ revokedAt: NOW })
      .where(eq(roomLinks.id, linkId));
    google(answer(200, { items: [event()], nextSyncToken: 's' }));

    await sync.sync(mentorId, NOW);

    expect(await instances()).toEqual([]);
  });

  it('leaves out a link of a cohort the organiser does not manage', async () => {
    await link(OTHER_CODE, otherCohortId);
    google(
      answer(200, {
        items: [event({ location: `${APP_URL}/join/${OTHER_CODE}` })],
        nextSyncToken: 's',
      }),
    );

    await sync.sync(mentorId, NOW);

    expect(await instances()).toEqual([]);
  });

  it('keeps an admin’s event for any cohort', async () => {
    const adminId = await person('admin@campus.local', SystemRole.Admin);
    await grants.save(adminId, 'admin-refresh');
    await link(OTHER_CODE, otherCohortId);
    google(
      answer(200, {
        items: [event({ location: `${APP_URL}/join/${OTHER_CODE}` })],
        nextSyncToken: 's',
      }),
    );

    await sync.sync(adminId, NOW);

    expect(await instances()).toHaveLength(1);
  });

  it('keeps nothing from a student', async () => {
    const studentId = await person('student@campus.local');
    await grants.save(studentId, 'student-refresh');
    google(answer(200, { items: [event()], nextSyncToken: 's' }));

    await sync.sync(studentId, NOW);

    expect(await instances()).toEqual([]);
  });

  it('applies nothing when the pages run out before the sync token', async () => {
    for (let i = 0; i < 40; i++) {
      fetch.mockResolvedValueOnce(
        answer(200, { items: [event()], nextPageToken: `p${i}` }),
      );
    }

    await expect(sync.sync(mentorId, NOW)).rejects.toThrow();

    expect(await instances()).toEqual([]);
    expect(await grantRow(mentorId)).toMatchObject({
      syncToken: null,
      syncLeaseUntil: null,
    });
  });
});

describe('an incremental read', () => {
  beforeEach(async () => {
    google(answer(200, { items: [event()], nextSyncToken: 'sync-1' }));
    await sync.sync(mentorId, NOW);
  });

  it('asks for changes since the last token', async () => {
    google(answer(200, { items: [], nextSyncToken: 'sync-2' }));

    await sync.sync(mentorId, NOW);

    const url = requestedUrl(1);
    expect(url.searchParams.get('syncToken')).toBe('sync-1');
    expect(url.searchParams.get('timeMin')).toBeNull();
    expect((await grantRow(mentorId)).syncToken).toBe('sync-2');
  });

  it('moves an instance moved in Google', async () => {
    google(
      answer(200, {
        items: [
          event({
            start: { dateTime: '2026-11-10T14:00:00Z' },
            end: { dateTime: '2026-11-10T15:00:00Z' },
          }),
        ],
        nextSyncToken: 'sync-2',
      }),
    );

    await sync.sync(mentorId, NOW);

    expect(await instances()).toEqual([
      expect.objectContaining({
        startsAt: new Date('2026-11-10T14:00:00Z'),
        cancelledAt: null,
      }),
    ]);
  });

  it.each([
    ['cancelled', { status: 'cancelled', organizer: undefined }],
    ['stripped of its link', { location: 'Room 4' }],
  ])('cancels an instance %s', async (_, overrides) => {
    google(answer(200, { items: [event(overrides)], nextSyncToken: 'sync-2' }));

    await sync.sync(mentorId, NOW);

    expect((await instances())[0].cancelledAt).toEqual(NOW);
  });

  it('cancels every instance of a series deleted whole', async () => {
    google(
      answer(200, {
        items: [{ id: 'standup', status: 'cancelled' }],
        nextSyncToken: 'sync-2',
      }),
    );

    await sync.sync(mentorId, NOW);

    expect((await instances())[0].cancelledAt).toEqual(NOW);
  });

  it('brings back an instance restored in Google', async () => {
    google(
      answer(200, {
        items: [event({ status: 'cancelled' })],
        nextSyncToken: 'sync-2',
      }),
      answer(200, { items: [event()], nextSyncToken: 'sync-3' }),
    );

    await sync.sync(mentorId, NOW);
    await sync.sync(mentorId, NOW);

    expect((await instances())[0].cancelledAt).toBeNull();
  });

  it('reads in full when Google drops the token, cancelling what it no longer has', async () => {
    google(
      answer(410, { error: { code: 410 } }),
      answer(200, { items: [], nextSyncToken: 'fresh' }),
    );

    await sync.sync(mentorId, NOW);

    expect(requestedUrl(2).searchParams.get('syncToken')).toBeNull();
    expect((await instances())[0].cancelledAt).toEqual(NOW);
    expect((await grantRow(mentorId)).syncToken).toBe('fresh');
  });
});

describe('two syncs of one calendar', () => {
  it('leaves word instead of reading alongside', async () => {
    await db
      .update(googleCalendarGrants)
      .set({ syncLeaseUntil: new Date(NOW.getTime() + 60_000) })
      .where(eq(googleCalendarGrants.userId, mentorId));

    await sync.sync(mentorId, NOW);

    expect(fetch).not.toHaveBeenCalled();
    expect((await grantRow(mentorId)).syncPending).toBe(true);
  });

  it('reads again when word arrives mid-read', async () => {
    fetch.mockImplementationOnce(async () => {
      await sync.sync(mentorId, NOW);
      return answer(200, { items: [], nextSyncToken: 'sync-1' });
    });
    google(answer(200, { items: [event()], nextSyncToken: 'sync-2' }));

    await sync.sync(mentorId, NOW);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(requestedUrl(1).searchParams.get('syncToken')).toBe('sync-1');
    expect(await instances()).toHaveLength(1);
    expect(await grantRow(mentorId)).toMatchObject({
      syncToken: 'sync-2',
      syncLeaseUntil: null,
      syncPending: false,
    });
  });

  it('takes over a lease left to lapse', async () => {
    await db
      .update(googleCalendarGrants)
      .set({ syncLeaseUntil: new Date(NOW.getTime() - 1) })
      .where(eq(googleCalendarGrants.userId, mentorId));
    google(answer(200, { items: [], nextSyncToken: 's' }));

    await sync.sync(mentorId, NOW);

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it('forgets a grant Google has withdrawn', async () => {
  google(
    answer(403, {
      error: { errors: [{ reason: 'insufficientPermissions' }] },
    }),
  );

  await sync.sync(mentorId, NOW);

  expect(await grantRow(mentorId)).toBeUndefined();
  expect(tokens.evict).toHaveBeenCalledWith(mentorId);
});
