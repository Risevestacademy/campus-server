import { SystemRole, UserStatus } from '../../modules/users/schema.js';
import type { Db } from './database.constants.js';
import { seedAdmin } from './seeder.js';

const EMAIL = 'admin@campus.local';

function makeLogger() {
  return { info: vi.fn() };
}

/**
 * Captures the single upsert `seedAdmin` issues. `returning` resolves to the
 * rows Postgres would hand back: one row when the statement inserted or
 * updated, none when `setWhere` skipped the update.
 */
function makeDb(returning: { id: string; createdAt: Date; updatedAt: Date }[]) {
  const calls = {
    values: undefined as Record<string, unknown> | undefined,
    conflict: undefined as Record<string, unknown> | undefined,
  };

  const db = {
    insert: vi.fn().mockReturnValue({
      values: (values: Record<string, unknown>) => {
        calls.values = values;
        return {
          onConflictDoUpdate: (conflict: Record<string, unknown>) => {
            calls.conflict = conflict;
            return { returning: vi.fn().mockResolvedValue(returning) };
          },
        };
      },
    }),
  };

  return { db: db as unknown as Db, calls };
}

const inserted = (at = new Date('2026-01-01T00:00:00Z')) => [
  { id: 'user-1', createdAt: at, updatedAt: at },
];
const updated = () => [
  {
    id: 'user-1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
  },
];

describe('seedAdmin', () => {
  it('inserts the configured address as an active admin', async () => {
    const { db, calls } = makeDb(inserted());

    const outcome = await seedAdmin(db, EMAIL, makeLogger());

    expect(outcome).toBe('created');
    expect(calls.values).toEqual({
      email: EMAIL,
      systemRole: SystemRole.Admin,
      status: UserStatus.Active,
    });
  });

  it('resolves the conflict in one statement instead of checking first', async () => {
    const { db, calls } = makeDb(inserted());

    await seedAdmin(db, EMAIL, makeLogger());

    // No read before the write: concurrent seeds cannot both decide to insert.
    expect((db as unknown as { select?: unknown }).select).toBeUndefined();
    expect(calls.conflict?.target).toBeDefined();
    expect(calls.conflict?.set).toMatchObject({ systemRole: SystemRole.Admin });
    expect(calls.conflict?.setWhere).toBeDefined();
  });

  it('never touches status, so a suspended admin stays suspended', async () => {
    const { db, calls } = makeDb([]);

    await seedAdmin(db, EMAIL, makeLogger());

    expect(calls.conflict?.set).not.toHaveProperty('status');
  });

  it('lowercases and trims the address to match the unique index', async () => {
    const { db, calls } = makeDb(inserted());

    await seedAdmin(db, '  Admin@Campus.Local  ', makeLogger());

    expect(calls.values).toMatchObject({ email: EMAIL });
  });

  it('reports a promotion when the statement updated an existing row', async () => {
    const { db } = makeDb(updated());
    const logger = makeLogger();

    expect(await seedAdmin(db, EMAIL, logger)).toBe('promoted');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ email: EMAIL }),
      'promoted existing user to admin',
    );
  });

  it('reports no change when the address is already an admin', async () => {
    const { db } = makeDb([]);

    expect(await seedAdmin(db, EMAIL, makeLogger())).toBe('unchanged');
  });
});
