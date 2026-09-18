import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import { SystemRole, UserStatus, users } from '../../modules/users/schema.js';
import type { Db } from './database.constants.js';
import { seedAdmin } from './seeder.js';

/**
 * Against a real PostgreSQL engine rather than a mocked query builder: the
 * things that can go wrong here — two deploys racing, an address that differs
 * only by case — are decided by the unique index, which a mock cannot model.
 */
const MIGRATIONS = fileURLToPath(new URL('./migrations', import.meta.url));
const EMAIL = 'admin@campus.local';

const pglite = drizzle(new PGlite(), { schema: { users } });
const db = pglite as unknown as Db;

function makeLogger() {
  return { info: vi.fn() };
}

const rows = () =>
  pglite
    .select({
      email: users.email,
      systemRole: users.systemRole,
      status: users.status,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users);

beforeAll(async () => {
  await migrate(pglite, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await pglite.execute(sql`truncate users cascade`);
});

describe('seedAdmin', () => {
  it('creates the admin when the address is unknown', async () => {
    expect(await seedAdmin(db, EMAIL, makeLogger())).toBe('created');

    expect(await rows()).toEqual([
      expect.objectContaining({
        email: EMAIL,
        systemRole: SystemRole.Admin,
        status: UserStatus.Active,
      }),
    ]);
  });

  it('does nothing on a second run', async () => {
    await seedAdmin(db, EMAIL, makeLogger());

    expect(await seedAdmin(db, EMAIL, makeLogger())).toBe('unchanged');
    expect(await rows()).toHaveLength(1);
  });

  it('promotes an existing user and bumps updated_at', async () => {
    await pglite.insert(users).values({ email: EMAIL });

    expect(await seedAdmin(db, EMAIL, makeLogger())).toBe('promoted');

    const [row] = await rows();
    expect(row.systemRole).toBe(SystemRole.Admin);
    expect(row.updatedAt.getTime()).toBeGreaterThan(row.createdAt.getTime());
  });

  it('cannot produce two admins when two deploys seed at once', async () => {
    const outcomes = await Promise.all([
      seedAdmin(db, EMAIL, makeLogger()),
      seedAdmin(db, EMAIL, makeLogger()),
    ]);

    expect(await rows()).toHaveLength(1);
    expect(outcomes).toContain('created');
  });

  it('treats a differently cased address as the same account', async () => {
    await seedAdmin(db, EMAIL, makeLogger());

    expect(await seedAdmin(db, 'Admin@Campus.Local', makeLogger())).toBe(
      'unchanged',
    );
    expect(await rows()).toHaveLength(1);
  });

  it('trims surrounding whitespace off the configured address', async () => {
    await seedAdmin(db, `  ${EMAIL}  `, makeLogger());

    expect((await rows())[0].email).toBe(EMAIL);
  });

  it('leaves a suspended admin suspended', async () => {
    await pglite.insert(users).values({
      email: EMAIL,
      systemRole: SystemRole.Admin,
      status: UserStatus.Suspended,
    });

    expect(await seedAdmin(db, EMAIL, makeLogger())).toBe('unchanged');
    expect((await rows())[0].status).toBe(UserStatus.Suspended);
  });
});
