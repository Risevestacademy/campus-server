import { PGlite } from '@electric-sql/pglite';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import type { PinoLogger } from 'nestjs-pino';

import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { AuditAction, AuditSubjectType, auditLog } from '../audit/schema.js';
import { SystemRole, users } from '../users/schema.js';
import { MapPublishService } from './map-publish.service.js';
import {
  MapNotEntryException,
  MapNotFoundException,
  MapRetiredException,
} from './maps.exceptions.js';
import { maps } from './schema.js';

/**
 * Against a real engine (PGlite, committed migrations applied). What a
 * publish writes, what it refuses to write, and that a failed notification
 * leaves the publish standing are all facts about rows.
 */
const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);

const db = drizzle(new PGlite(), { schema: { users, maps, auditLog } });

const notify = vi.fn<(executor: unknown, key: string) => Promise<void>>(
  async () => undefined,
);
const logger = {
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as PinoLogger;
const service = new MapPublishService(db as never, notify, logger);

let admin: AuthenticatedUser;
let campusId: string;
let annexId: string;
let retiredId: string;

const mapRow = async (id: string) =>
  (await db.select().from(maps).where(eq(maps.id, id)))[0];

const entries = () =>
  db
    .select({
      action: auditLog.action,
      subjectType: auditLog.subjectType,
      subjectId: auditLog.subjectId,
      details: auditLog.details,
      actorUserId: auditLog.actorUserId,
    })
    .from(auditLog)
    .orderBy(asc(auditLog.createdAt), asc(auditLog.id));

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(sql`truncate audit_log, spaces, maps, users cascade`);
  notify.mockClear();
  notify.mockImplementation(async () => undefined);
  (logger.warn as unknown as ReturnType<typeof vi.fn>).mockClear();

  const [row] = await db
    .insert(users)
    .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
    .returning();
  admin = { id: row.id, email: row.email, systemRole: row.systemRole };

  [campusId] = (
    await db
      .insert(maps)
      .values({ key: 'campus', name: 'Campus', isEntry: true })
      .returning({ id: maps.id })
  ).map((map) => map.id);
  [annexId] = (
    await db
      .insert(maps)
      .values({ key: 'annex', name: 'Annex' })
      .returning({ id: maps.id })
  ).map((map) => map.id);
  [retiredId] = (
    await db
      .insert(maps)
      .values({
        key: 'old',
        name: 'Old',
        retiredAt: new Date('2026-01-01T00:00:00Z'),
      })
      .returning({ id: maps.id })
  ).map((map) => map.id);
});

describe('publishing a map', () => {
  it('sets when it went live, records who did it, and tells world its key', async () => {
    const now = new Date('2026-10-01T10:00:00Z');

    await expect(
      service.publish(campusId, { actorUserId: admin.id }, now),
    ).resolves.toEqual({ id: campusId, key: 'campus', publishedAt: now });

    await expect(mapRow(campusId)).resolves.toMatchObject({
      publishedAt: now,
    });
    expect(await entries()).toEqual([
      {
        action: AuditAction.MapPublished,
        subjectType: AuditSubjectType.Map,
        subjectId: campusId,
        actorUserId: admin.id,
        details: {
          key: 'campus',
          previousPublishedAt: null,
          publishedAt: now.toISOString(),
        },
      },
    ]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(db, 'campus');
  });

  it('moves the timestamp, writes a second entry, and tells world again', async () => {
    const first = new Date('2026-10-01T10:00:00Z');
    const second = new Date('2026-10-01T10:05:00Z');

    await service.publish(campusId, { actorUserId: admin.id }, first);
    await service.publish(campusId, { actorUserId: admin.id }, second);

    await expect(mapRow(campusId)).resolves.toMatchObject({
      publishedAt: second,
    });
    const written = await entries();
    expect(written).toHaveLength(2);
    expect(written[1]?.details).toEqual({
      key: 'campus',
      previousPublishedAt: first.toISOString(),
      publishedAt: second.toISOString(),
    });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith(db, 'campus');
  });

  it('keeps the later timestamp and both entries on two sequential publishes', async () => {
    await service.publish(
      campusId,
      { actorUserId: admin.id },
      new Date('2026-10-01T10:00:00Z'),
    );
    await service.publish(
      campusId,
      { actorUserId: admin.id },
      new Date('2026-10-01T10:01:00Z'),
    );

    await expect(mapRow(campusId)).resolves.toMatchObject({
      publishedAt: new Date('2026-10-01T10:01:00Z'),
    });
    expect(await entries()).toHaveLength(2);
  });
});

describe('what a publish refuses', () => {
  it('refuses a retired map, writing and telling nobody', async () => {
    await expect(
      service.publish(retiredId, { actorUserId: admin.id }),
    ).rejects.toBeInstanceOf(MapRetiredException);

    await expect(mapRow(retiredId)).resolves.toMatchObject({
      publishedAt: null,
    });
    await expect(entries()).resolves.toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('refuses a map that is not the entry map', async () => {
    await expect(
      service.publish(annexId, { actorUserId: admin.id }),
    ).rejects.toBeInstanceOf(MapNotEntryException);

    await expect(mapRow(annexId)).resolves.toMatchObject({
      publishedAt: null,
    });
    await expect(entries()).resolves.toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('answers no such map, writing and telling nobody', async () => {
    await expect(
      service.publish('00000000-0000-4000-8000-000000000000', {
        actorUserId: admin.id,
      }),
    ).rejects.toBeInstanceOf(MapNotFoundException);

    await expect(entries()).resolves.toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('when something after the row fails', () => {
  /**
   * PGlite has no easy way to make `pg_notify` itself refuse, so the test
   * that matters here is the audit insert: the entry is in the transaction,
   * so its failure must take the timestamp with it.
   */
  it('leaves the timestamp alone when the audit entry cannot be written', async () => {
    await db.execute(
      sql`alter table audit_log add constraint map_published_must_not_be_written check (action <> 'map_published')`,
    );
    try {
      await expect(
        service.publish(campusId, { actorUserId: admin.id }),
      ).rejects.toThrow();
    } finally {
      await db.execute(
        sql`alter table audit_log drop constraint map_published_must_not_be_written`,
      );
    }

    await expect(mapRow(campusId)).resolves.toMatchObject({
      publishedAt: null,
    });
    await expect(entries()).resolves.toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('keeps the publish when the notification fails, and logs it', async () => {
    notify.mockRejectedValueOnce(new Error('postgres is down'));

    await expect(
      service.publish(campusId, { actorUserId: admin.id }),
    ).resolves.toMatchObject({ key: 'campus' });

    await expect(mapRow(campusId)).resolves.toMatchObject({
      publishedAt: expect.any(Date),
    });
    await expect(entries()).resolves.toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mapKey: 'campus' }),
      'could not tell world a map was published',
    );
  });
});
