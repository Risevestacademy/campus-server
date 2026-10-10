import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import { users } from '../users/schema.js';
import { AuditLogService } from './audit-log.service.js';
import type { ListAuditLogQueryDto } from './dto/list-audit-log.dto.js';
import {
  AuditAction,
  AuditSubjectType,
  auditLog,
  type NewAuditLogEntry,
} from './schema.js';

/**
 * Against a real engine (PGlite, committed migrations applied): the filters
 * are SQL, and a mocked query builder would only prove they were called.
 */
const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);

const db = drizzle(new PGlite(), { schema: { users, auditLog } });
const service = new AuditLogService(db as never);

const TRACK = '11111111-1111-4111-8111-111111111111';
const COHORT = '22222222-2222-4222-8222-222222222222';
const INVITE = '33333333-3333-4333-8333-333333333333';

let ada: string;
let grace: string;

/** An entry written at `at`, so a test can name the order and the range. */
const entry = (
  label: string,
  at: string,
  fields: Omit<NewAuditLogEntry, 'correlationId' | 'createdAt'>,
) =>
  db.insert(auditLog).values({
    ...fields,
    // The label rides in correlationId, which nothing filters on.
    correlationId: label,
    createdAt: new Date(at),
  });

const labels = async (filters: Partial<ListAuditLogQueryDto> = {}) => {
  const page = await service.list({ page: 1, perPage: 20, ...filters });
  return page.items.map((item) => item.correlationId);
};

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(sql`truncate audit_log, users cascade`);
  const [first, second] = await db
    .insert(users)
    .values([{ email: 'ada@campus.local' }, { email: 'grace@campus.local' }])
    .returning();
  [ada, grace] = [first.id, second.id];

  await entry('track-created', '2026-10-01T09:00:00Z', {
    actorUserId: ada,
    action: AuditAction.TrackCreated,
    subjectType: AuditSubjectType.Track,
    subjectId: TRACK,
    details: { name: 'Software Engineering', code: 'SE' },
  });
  await entry('cohort-created', '2026-10-02T09:00:00Z', {
    actorUserId: grace,
    action: AuditAction.CohortCreated,
    subjectType: AuditSubjectType.Cohort,
    subjectId: COHORT,
  });
  await entry('track-updated', '2026-10-03T09:00:00Z', {
    actorUserId: grace,
    action: AuditAction.TrackUpdated,
    subjectType: AuditSubjectType.Track,
    subjectId: TRACK,
  });
  await entry('invite-created', '2026-10-04T09:00:00Z', {
    actorUserId: ada,
    action: AuditAction.InviteCreated,
    subjectType: AuditSubjectType.Invite,
    subjectId: INVITE,
  });
  await entry('seeded', '2026-10-05T09:00:00Z', {
    actorUserId: null,
    action: AuditAction.SystemRoleChanged,
    subjectType: AuditSubjectType.User,
    subjectId: ada,
  });
});

describe('AuditLogService', () => {
  it('lists every entry, newest first, with pagination totals', async () => {
    const page = await service.list({ page: 1, perPage: 2 });

    expect(page.items.map((item) => item.correlationId)).toEqual([
      'seeded',
      'invite-created',
    ]);
    expect(page.meta).toEqual({
      page: 1,
      perPage: 2,
      total: 5,
      totalPages: 3,
    });
    expect((await service.list({ page: 3, perPage: 2 })).items).toHaveLength(1);
  });

  it('carries what was written, and not the reserved space id', async () => {
    const page = await service.list({
      page: 1,
      perPage: 20,
      action: AuditAction.TrackCreated,
    });

    expect(page.items).toEqual([
      {
        id: expect.any(String),
        actorUserId: ada,
        action: AuditAction.TrackCreated,
        subjectType: AuditSubjectType.Track,
        subjectId: TRACK,
        details: { name: 'Software Engineering', code: 'SE' },
        correlationId: 'track-created',
        createdAt: new Date('2026-10-01T09:00:00Z'),
      },
    ]);
  });

  // Entries written in one transaction share a created_at.
  it('keeps entries with the same time in one order across pages', async () => {
    await db.execute(sql`truncate audit_log`);
    for (const label of ['a', 'b', 'c', 'd']) {
      await entry(label, '2026-10-01T09:00:00Z', {
        actorUserId: null,
        action: AuditAction.TrackCreated,
      });
    }

    const pages = await Promise.all(
      [1, 2].map((page) => labels({ page, perPage: 2 })),
    );

    expect(pages.flat().sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('filters by action', async () => {
    expect(await labels({ action: AuditAction.TrackUpdated })).toEqual([
      'track-updated',
    ]);
  });

  it('filters by the actor', async () => {
    expect(await labels({ actorUserId: ada })).toEqual([
      'invite-created',
      'track-created',
    ]);
    expect(await labels({ actorUserId: grace })).toEqual([
      'track-updated',
      'cohort-created',
    ]);
  });

  it('filters by the kind of subject', async () => {
    expect(await labels({ subjectType: AuditSubjectType.Track })).toEqual([
      'track-updated',
      'track-created',
    ]);
  });

  it('filters by the subject’s id', async () => {
    expect(await labels({ subjectId: TRACK })).toEqual([
      'track-updated',
      'track-created',
    ]);
    expect(
      await labels({ subjectType: AuditSubjectType.Track, subjectId: TRACK }),
    ).toEqual(['track-updated', 'track-created']);
    // The id names a track, so nothing about a cohort matches it.
    expect(
      await labels({ subjectType: AuditSubjectType.Cohort, subjectId: TRACK }),
    ).toEqual([]);
  });

  it('filters from an instant, including it', async () => {
    expect(await labels({ from: '2026-10-04T09:00:00Z' })).toEqual([
      'seeded',
      'invite-created',
    ]);
  });

  it('filters to an instant, leaving it out', async () => {
    expect(await labels({ to: '2026-10-02T09:00:00Z' })).toEqual([
      'track-created',
    ]);
  });

  it('filters by a range of days', async () => {
    expect(await labels({ from: '2026-10-02', to: '2026-10-04' })).toEqual([
      'track-updated',
      'cohort-created',
    ]);
  });

  it('reads a zoned timestamp in its own zone', async () => {
    // 10:00 in Lagos is 09:00 UTC: the cohort entry's own instant.
    expect(
      await labels({
        from: '2026-10-02T10:00:00+01:00',
        to: '2026-10-03T00:00:00Z',
      }),
    ).toEqual(['cohort-created']);
  });

  it('combines the filters', async () => {
    expect(
      await labels({
        actorUserId: grace,
        subjectType: AuditSubjectType.Track,
        from: '2026-10-01',
      }),
    ).toEqual(['track-updated']);
    expect(
      await labels({ actorUserId: ada, action: AuditAction.TrackUpdated }),
    ).toEqual([]);
  });

  it('answers an id that names nothing with an empty page', async () => {
    const page = await service.list({
      page: 1,
      perPage: 20,
      actorUserId: '99999999-9999-4999-8999-999999999999',
    });

    expect(page.items).toEqual([]);
    expect(page.meta).toMatchObject({ total: 0, totalPages: 0 });
  });
});
