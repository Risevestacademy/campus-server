import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { migrate as migratePg } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

import { AuditAction, auditLog } from '../../modules/audit/schema.js';
import { SessionIssuer } from '../../modules/auth/session-issuer.js';
import { SystemRole, UserStatus, users } from '../../modules/users/schema.js';
import { UserRolesService } from '../../modules/users/user-roles.service.js';
import type { Db } from './database.constants.js';
import { seedAdmin, seedAdmins } from './seeder.js';

/**
 * Against a real PostgreSQL engine rather than a mocked query builder: the
 * things that can go wrong here — two deploys racing, an address that differs
 * only by case — are decided by the unique index, which a mock cannot model.
 */
const MIGRATIONS = fileURLToPath(new URL('./migrations', import.meta.url));
const EMAIL = 'admin@campus.local';

const pglite = drizzle(new PGlite(), { schema: { users, auditLog } });
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
  await pglite.execute(sql`truncate audit_log, users cascade`);
});

describe('seedAdmin', () => {
  it('creates the admin when the address is unknown', async () => {
    expect(await seedAdmin(db, EMAIL, makeLogger())).toBe('created');

    expect(await rows()).toEqual([
      expect.objectContaining({
        email: EMAIL,
        systemRole: SystemRole.SuperAdmin,
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
    // Timestamped in the past on purpose: both columns default to now(), and
    // two statements in the same millisecond are indistinguishable once a JS
    // Date has truncated them — which made this assertion flaky.
    const earlier = new Date(Date.now() - 60_000);
    await pglite
      .insert(users)
      .values({ email: EMAIL, createdAt: earlier, updatedAt: earlier });

    expect(await seedAdmin(db, EMAIL, makeLogger())).toBe('promoted');

    const [row] = await rows();
    expect(row.systemRole).toBe(SystemRole.SuperAdmin);
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
      systemRole: SystemRole.SuperAdmin,
      status: UserStatus.Suspended,
    });

    expect(await seedAdmin(db, EMAIL, makeLogger())).toBe('unchanged');
    expect((await rows())[0].status).toBe(UserStatus.Suspended);
  });
});

describe('seedAdmins', () => {
  it('seeds every address, and says what happened to each', async () => {
    await seedAdmin(db, 'ada@campus.local', makeLogger());

    const outcomes = await seedAdmins(
      db,
      ['ada@campus.local', 'grace@campus.local'],
      makeLogger(),
    );

    expect(outcomes).toEqual({
      'ada@campus.local': 'unchanged',
      'grace@campus.local': 'created',
    });
    expect((await rows()).map((row) => row.systemRole)).toEqual([
      SystemRole.SuperAdmin,
      SystemRole.SuperAdmin,
    ]);
  });
});

describe('seedAdmin audit log', () => {
  const entries = () =>
    pglite
      .select({
        actorUserId: auditLog.actorUserId,
        action: auditLog.action,
        details: auditLog.details,
      })
      .from(auditLog);

  it('records a new admin as a grant nobody signed in to make', async () => {
    await seedAdmin(db, EMAIL, makeLogger());

    expect(await entries()).toEqual([
      {
        actorUserId: null,
        action: AuditAction.SystemRoleChanged,
        details: { from: null, to: SystemRole.SuperAdmin, source: 'seed' },
      },
    ]);
  });

  it('records a promotion from user', async () => {
    const earlier = new Date(Date.now() - 60_000);
    await pglite
      .insert(users)
      .values({ email: EMAIL, createdAt: earlier, updatedAt: earlier });

    await seedAdmin(db, EMAIL, makeLogger());

    expect(await entries()).toEqual([
      expect.objectContaining({
        details: {
          from: SystemRole.User,
          to: SystemRole.SuperAdmin,
          source: 'seed',
        },
      }),
    ]);
  });

  // An account seeded before the role existed: an admin, to be raised.
  it('raises an existing admin, and records what they were', async () => {
    await db
      .insert(users)
      .values({ email: EMAIL, systemRole: 'admin' as never });

    expect(await seedAdmin(db, EMAIL, makeLogger())).toBe('promoted');

    const [entry] = await pglite.select().from(auditLog);
    expect(entry.details).toEqual({
      from: 'admin',
      to: SystemRole.SuperAdmin,
      source: 'seed',
    });
  });

  it('records nothing on a re-run', async () => {
    await seedAdmin(db, EMAIL, makeLogger());
    await seedAdmin(db, EMAIL, makeLogger());

    expect(await entries()).toHaveLength(1);
  });
});

/**
 * The seed beside an admin changing the same account's role through the API,
 * each on its own connection. PGlite has one connection and runs the two one
 * after the other, so this needs a real PostgreSQL: set
 * CAMPUS_TEST_DATABASE_URL to a database nothing else uses and the migrations
 * are applied to it. Rows are made under fresh addresses and never cleared.
 */
const realUrl = process.env.CAMPUS_TEST_DATABASE_URL;

describe.skipIf(!realUrl)('seedAdmin beside an API role change', () => {
  let client: ReturnType<typeof postgres>;
  let pg: ReturnType<typeof drizzlePg>;
  let roles: UserRolesService;

  beforeAll(async () => {
    client = postgres(realUrl as string, {
      max: 10,
      onnotice: () => undefined,
    });
    pg = drizzlePg(client, { schema: { users, auditLog } });
    await migratePg(pg, { migrationsFolder: MIGRATIONS });
    roles = new UserRolesService(
      pg as never,
      new SessionIssuer({} as never, pg as never, {} as never, {} as never),
    );
  });

  afterAll(async () => {
    await client.end();
  });

  // The entry says which role the seed replaced. If an admin made the
  // account an admin a moment before, that is `admin`; an entry still
  // saying `user` would be a history of something that did not happen.
  it('records the role it actually replaced, whichever lands first', async () => {
    const quiet = { info: () => undefined };
    const wrong: string[] = [];

    for (let round = 0; round < 60; round += 1) {
      const tag = `${Date.now()}-${round}-${Math.random().toString(36).slice(2)}`;
      const [actor, target] = await pg
        .insert(users)
        .values([
          { email: `actor-${tag}@campus.local`, systemRole: SystemRole.Admin },
          { email: `target-${tag}@campus.local`, systemRole: SystemRole.User },
        ])
        .returning();

      await Promise.allSettled([
        seedAdmin(pg as never, target.email, quiet),
        roles.setSystemRole(
          { id: actor.id, email: actor.email, systemRole: actor.systemRole },
          target.id,
          SystemRole.Admin,
        ),
      ]);

      const entries = await pg
        .select()
        .from(auditLog)
        .where(eq(auditLog.subjectId, target.id));
      const details = entries.map(
        (entry) =>
          entry.details as { from: string; to: string; source: string },
      );
      const bySeed = details.find((entry) => entry.source === 'seed');
      const byAdmin = details.find((entry) => entry.source === 'admin');
      // Once the seed has run the account is a super admin and the API
      // refuses to touch it, so an entry by the admin can only have come
      // first.
      const replaced = byAdmin ? SystemRole.Admin : SystemRole.User;
      const [after] = await pg
        .select()
        .from(users)
        .where(eq(users.id, target.id));

      if (
        bySeed?.from !== replaced ||
        after.systemRole !== SystemRole.SuperAdmin
      ) {
        wrong.push(
          `round ${round}: seed says from ${bySeed?.from}, replaced ${replaced}, ended ${after.systemRole}`,
        );
      }
    }

    expect(wrong).toEqual([]);
  }, 120_000);
});
