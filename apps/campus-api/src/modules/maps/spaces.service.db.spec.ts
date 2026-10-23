import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import { AuditAction, AuditSubjectType, auditLog } from '../audit/schema.js';
import { SystemRole, users } from '../users/schema.js';
import type { UpdateSpaceDto } from './dto/space.dto.js';
import {
  SpaceConflictException,
  SpaceInvalidArgumentException,
  SpaceNotFoundException,
} from './maps.exceptions.js';
import {
  AudioMode,
  SpaceAccess,
  SpaceKind,
  maps,
  spaces,
  type NewSpace,
} from './schema.js';
import { SpacesService } from './spaces.service.js';

/**
 * The rules the database keeps for a space are the ones the update route has
 * to answer for, so they are shown here against a real engine with the
 * committed migrations applied. The audit entry is part of the same act: a
 * refused update leaves neither a changed row nor an entry.
 */
const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);

const db = drizzle(new PGlite(), {
  schema: { users, maps, spaces, auditLog },
});

const service = new SpacesService(db as never);

const NOBODY = { actorUserId: '', correlationId: 'req-1' };
type Actor = typeof NOBODY;

let actor: Actor;
let mapId: string;
let keySeq = 0;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  keySeq = 0;
  await db.execute(
    sql`truncate audit_log, space_memberships, spaces, maps, users cascade`,
  );

  const [admin] = await db
    .insert(users)
    .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
    .returning();
  actor = { actorUserId: admin.id, correlationId: 'req-1' };

  const [map] = await db
    .insert(maps)
    .values({ key: 'campus', name: 'Campus', isEntry: true })
    .returning();
  mapId = map.id;
});

/** A live space with the settings nobody has chosen yet. */
async function given(overrides: Partial<NewSpace> = {}) {
  const n = keySeq++;
  const [row] = await db
    .insert(spaces)
    .values({
      mapId,
      key: `space-${n}`,
      name: `Space ${n}`,
      kind: SpaceKind.Open,
      audioMode: AudioMode.Proximity,
      access: SpaceAccess.Normal,
      ...overrides,
    })
    .returning();
  return row;
}

const entries = () => db.select().from(auditLog);

/** The error a write refused with, so its class and message can be read. */
async function refusal(write: Promise<unknown>): Promise<Error> {
  try {
    await write;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the write to be refused');
}

describe('listing spaces', () => {
  it('lists live spaces by name and leaves retired ones out', async () => {
    const second = await given({ name: 'Beta', kind: null });
    const first = await given({ name: 'Alpha' });
    const retired = await given({
      name: 'Gamma',
      kind: null,
      retiredAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const page = await service.list({
      page: 1,
      perPage: 20,
      needsKind: false,
    });

    expect(page.items.map((row) => row.id)).toEqual([first.id, second.id]);
    expect(page.items.map((row) => row.id)).not.toContain(retired.id);
    expect(page.meta).toEqual({
      page: 1,
      perPage: 20,
      total: 2,
      totalPages: 1,
    });
  });

  it('narrows the list to live spaces with no kind', async () => {
    await given({ name: 'Set up' });
    const waiting = await given({ name: 'Waiting', kind: null });
    await given({
      name: 'Retired waiting',
      kind: null,
      retiredAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const page = await service.list({
      page: 1,
      perPage: 20,
      needsKind: true,
    });

    expect(page.items.map((row) => row.id)).toEqual([waiting.id]);
    expect(page.meta.total).toBe(1);
  });
});

describe('reading one space', () => {
  it('answers with the row, retired or not', async () => {
    const retiredAt = new Date('2026-01-01T00:00:00.000Z');
    const row = await given({ retiredAt });

    await expect(service.get(row.id)).resolves.toEqual(row);
  });

  it('refuses no such space', async () => {
    await expect(
      service.get('99999999-9999-4999-8999-999999999999'),
    ).rejects.toBeInstanceOf(SpaceNotFoundException);
  });
});

describe('updating a space', () => {
  const ALLOWED = [
    ['name', 'Reading Room'],
    ['kind', SpaceKind.Classroom],
    ['access', SpaceAccess.Designated],
    ['audioMode', AudioMode.Boundary],
    ['capacity', 25],
    ['audibleRadius', 8.5],
    ['subscribeRadius', 10],
    ['hysteresisFactor', 1.5],
  ] as const;

  it.each(ALLOWED)(
    'writes %s and records its old and new value',
    async (field, value) => {
      const row = await given({ name: 'Library' });

      const updated = await service.update(
        row.id,
        { [field]: value } as UpdateSpaceDto,
        actor,
      );

      const expected =
        field === 'audibleRadius' ||
        field === 'subscribeRadius' ||
        field === 'hysteresisFactor'
          ? Number(value).toFixed(2)
          : value;
      expect(updated[field]).toEqual(expected);

      const [entry] = await entries();
      expect(entry).toMatchObject({
        actorUserId: actor.actorUserId,
        action: AuditAction.SpaceUpdated,
        subjectType: AuditSubjectType.Space,
        subjectId: row.id,
        spaceId: row.id,
        correlationId: 'req-1',
      });
      expect(entry.details).toEqual({
        changes: { [field]: { from: row[field], to: updated[field] } },
      });
    },
  );

  it('returns the row and writes no entry when nothing moved', async () => {
    const row = await given({ name: 'Library' });

    const empty = await service.update(row.id, {}, actor);
    const same = await service.update(row.id, { name: 'Library' }, actor);

    expect(empty.id).toBe(row.id);
    expect(same.id).toBe(row.id);
    expect(await entries()).toHaveLength(0);
  });

  it('refuses no such space', async () => {
    await expect(
      service.update(
        '99999999-9999-4999-8999-999999999999',
        { name: 'Nowhere' },
        actor,
      ),
    ).rejects.toBeInstanceOf(SpaceNotFoundException);
    expect(await entries()).toHaveLength(0);
  });

  it('refuses a default space that is not normal, and records nothing', async () => {
    const row = await given({
      isMapDefault: true,
      access: SpaceAccess.Normal,
    });

    const error = await refusal(
      service.update(row.id, { access: SpaceAccess.Designated }, actor),
    );
    expect(error).toBeInstanceOf(SpaceInvalidArgumentException);
    expect(error.message).toBe('The default space must be open to everybody');

    const [reread] = await db
      .select()
      .from(spaces)
      .where(eq(spaces.id, row.id));
    expect(reread.access).toBe(SpaceAccess.Normal);
    expect(await entries()).toHaveLength(0);
  });

  it('refuses a capacity below 1, and records nothing', async () => {
    const row = await given({ capacity: null });

    const error = await refusal(service.update(row.id, { capacity: 0 }, actor));
    expect(error).toBeInstanceOf(SpaceInvalidArgumentException);
    expect(error.message).toBe('Capacity must be at least 1');

    const [reread] = await db
      .select()
      .from(spaces)
      .where(eq(spaces.id, row.id));
    expect(reread.capacity).toBeNull();
    expect(await entries()).toHaveLength(0);
  });

  it.each([
    [SpaceKind.TownHall, 'The campus already has a town hall'],
    [SpaceKind.NoticeBoard, 'The campus already has a notice board'],
  ])('refuses a second %s, and records nothing', async (kind, message) => {
    await given({ kind });
    const target = await given();

    const error = await refusal(service.update(target.id, { kind }, actor));
    expect(error).toBeInstanceOf(SpaceConflictException);
    expect(error.message).toBe(message);
    expect((error as SpaceConflictException).details).toEqual({
      spaceId: target.id,
      kind,
    });

    const [reread] = await db
      .select()
      .from(spaces)
      .where(eq(spaces.id, target.id));
    expect(reread.kind).toBe(SpaceKind.Open);
    expect(await entries()).toHaveLength(0);
  });
});
