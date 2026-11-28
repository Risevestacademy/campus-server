import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import type { Env } from '../../infra/config/env.js';
import { AnalyticsErasureService } from './analytics-erasure.service.js';
import { UserStatus, users } from './schema.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);
const db = drizzle(new PGlite(), { schema: { users } });
const quiet = { setContext() {}, warn() {}, error() {}, info() {} };

const configured = {
  POSTHOG_PERSONAL_API_KEY: 'phx_test',
  POSTHOG_PROJECT_ID: '12345',
  POSTHOG_API_HOST: 'https://eu.posthog.com/',
} as Env;

const serviceWith = (config: Env, fetcher: typeof fetch) =>
  new AnalyticsErasureService(
    db as never,
    config,
    fetcher,
    { register() {} } as never,
    quiet as never,
  );

const deleted = async (email: string) => {
  const [row] = await db
    .insert(users)
    .values({ email, status: UserStatus.Deleted, deletedAt: new Date() })
    .returning();
  return row;
};
const accepted = (errors: unknown[] = []) =>
  new Response(
    JSON.stringify({
      persons_found: 1,
      persons_deleted: errors.length === 0 ? 1 : 0,
      persons_queued_for_deletion: 0,
      events_queued_for_deletion: false,
      recordings_queued_for_deletion: true,
      deletion_errors: errors,
    }),
    { status: 202 },
  );
const sentIds = (fetcher: ReturnType<typeof vi.fn>) =>
  fetcher.mock.calls.map(
    ([, init]) => JSON.parse((init as RequestInit).body as string).distinct_ids,
  );
const erasedAt = async (id: string) => {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row.analyticsErasedAt;
};

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(sql`truncate users cascade`);
});

describe('AnalyticsErasureService.erase', () => {
  it('drops deleted accounts’ PostHog profiles, keeps their events, and marks them', async () => {
    const gone = await deleted('gone@campus.local');
    await db.insert(users).values({ email: 'here@campus.local' });
    const fetcher = vi.fn(async () => accepted());
    const now = new Date('2026-11-19T10:00:00Z');

    await serviceWith(configured, fetcher as never).erase(now);

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'https://eu.posthog.com/api/projects/12345/persons/bulk_delete/',
    );
    expect(init.headers).toMatchObject({ authorization: 'Bearer phx_test' });
    expect(JSON.parse(init.body as string)).toEqual({
      distinct_ids: [gone.id],
      delete_events: false,
      delete_recordings: true,
    });
    expect(await erasedAt(gone.id)).toEqual(now);
  });

  it('retries one by one when PostHog lists failures, and marks only those deleted', async () => {
    const ok = await deleted('ok@campus.local');
    const stuck = await deleted('stuck@campus.local');
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const ids = JSON.parse(init.body as string).distinct_ids as string[];
      return accepted(
        ids.includes(stuck.id)
          ? [{ person_uuid: 'p-1', step: 'delete_person' }]
          : [],
      );
    });
    const now = new Date('2026-11-28T10:00:00Z');

    await serviceWith(configured, fetcher as never).erase(now);

    const calls = sentIds(fetcher);
    expect(calls).toHaveLength(3);
    expect(new Set(calls[0])).toEqual(new Set([ok.id, stuck.id]));
    expect(calls.slice(1)).toEqual(
      expect.arrayContaining([[ok.id], [stuck.id]]),
    );
    expect(await erasedAt(ok.id)).toEqual(now);
    expect(await erasedAt(stuck.id)).toBeNull();
  });

  it('leaves them waiting when the answer has no deletion_errors', async () => {
    const gone = await deleted('gone@campus.local');
    const fetcher = vi.fn(async () => new Response('{}', { status: 202 }));

    await serviceWith(configured, fetcher as never).erase(new Date());

    expect(await erasedAt(gone.id)).toBeNull();
  });

  it('leaves them waiting when PostHog refuses', async () => {
    const gone = await deleted('gone@campus.local');
    const fetcher = vi.fn(async () => new Response('', { status: 503 }));

    await serviceWith(configured, fetcher as never).erase(new Date());

    expect(await erasedAt(gone.id)).toBeNull();
  });

  it('does nothing without a personal API key', async () => {
    const gone = await deleted('gone@campus.local');
    const fetcher = vi.fn();

    await serviceWith(
      { POSTHOG_API_HOST: 'https://eu.posthog.com' } as Env,
      fetcher as never,
    ).erase(new Date());

    expect(fetcher).not.toHaveBeenCalled();
    expect(await erasedAt(gone.id)).toBeNull();
  });

  it('does not call PostHog when nobody is waiting', async () => {
    const fetcher = vi.fn();

    await serviceWith(configured, fetcher as never).erase(new Date());

    expect(fetcher).not.toHaveBeenCalled();
  });
});
