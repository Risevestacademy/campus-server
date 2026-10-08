import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { AccessDeniedException } from '../../shared/exceptions/index.js';
import { AuditAction, AuditSubjectType, auditLog } from '../audit/schema.js';
import { refreshTokens } from '../auth/schema.js';
import { SessionIssuer } from '../auth/session-issuer.js';
import { SystemRole, users } from './schema.js';
import { UserRolesService } from './user-roles.service.js';
import {
  SystemRoleLockedException,
  UserNotFoundException,
} from './users.exceptions.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);
const db = drizzle(new PGlite(), { schema: { users, auditLog } });
// The real issuer: ending the sessions is its work, and it only needs the
// database to do it.
const service = new UserRolesService(
  db as never,
  new SessionIssuer({} as never, db as never, {} as never, {} as never),
);

const person = async (email: string, systemRole = SystemRole.User) => {
  const [row] = await db
    .insert(users)
    .values({ email, systemRole })
    .returning();
  return row;
};
const actorOf = (row: typeof users.$inferSelect): AuthenticatedUser => ({
  id: row.id,
  email: row.email,
  systemRole: row.systemRole,
});
const roleOf = async (id: string) => {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row.systemRole;
};
const entries = () => db.select().from(auditLog);

let admin: typeof users.$inferSelect;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(sql`truncate audit_log, refresh_tokens, users cascade`);
  admin = await person('admin@campus.local', SystemRole.Admin);
});

describe('UserRolesService.setSystemRole', () => {
  it('makes a user an admin, and records who did it', async () => {
    const ada = await person('ada@campus.local');

    const result = await service.setSystemRole(
      actorOf(admin),
      ada.id,
      SystemRole.Admin,
      'corr-1',
    );

    expect(result).toEqual({
      id: ada.id,
      email: 'ada@campus.local',
      systemRole: SystemRole.Admin,
    });
    expect(await roleOf(ada.id)).toBe(SystemRole.Admin);
    expect(await entries()).toEqual([
      expect.objectContaining({
        actorUserId: admin.id,
        action: AuditAction.SystemRoleChanged,
        subjectType: AuditSubjectType.User,
        subjectId: ada.id,
        correlationId: 'corr-1',
        details: { from: 'user', to: 'admin', source: 'admin' },
      }),
    ]);
  });

  it('revokes another admin', async () => {
    const other = await person('other@campus.local', SystemRole.Admin);

    await service.setSystemRole(actorOf(admin), other.id, SystemRole.User);

    expect(await roleOf(other.id)).toBe(SystemRole.User);
    expect((await entries())[0].details).toEqual({
      from: 'admin',
      to: 'user',
      source: 'admin',
    });
  });

  const signedIn = async (userId: string) => {
    await db.insert(refreshTokens).values({
      userId,
      familyId: '77777777-7777-4777-8777-777777777777',
      tokenHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
  };
  const sessionsOf = async (userId: string) => {
    const [account] = await db.select().from(users).where(eq(users.id, userId));
    const tokens = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, userId));
    return {
      epoch: account.sessionEpoch,
      live: tokens.filter((token) => token.revokedAt === null).length,
    };
  };

  // An admin holds a session with no cohort behind it, so the role going
  // has to take the session with it or they keep both until it runs out.
  it('ends the sessions of an admin it revokes', async () => {
    const other = await person('other@campus.local', SystemRole.Admin);
    await signedIn(other.id);

    await service.setSystemRole(actorOf(admin), other.id, SystemRole.User);

    expect(await sessionsOf(other.id)).toEqual({ epoch: 1, live: 0 });
  });

  it('leaves the sessions of somebody it makes an admin', async () => {
    const ada = await person('ada@campus.local');
    await signedIn(ada.id);

    await service.setSystemRole(actorOf(admin), ada.id, SystemRole.Admin);

    expect(await sessionsOf(ada.id)).toEqual({ epoch: 0, live: 1 });
  });

  // The guard read the caller's role before the change began. By the time
  // it runs they may have been revoked themselves: the row decides.
  it('refuses a caller who is no longer an admin, whatever their request said', async () => {
    const other = await person('other@campus.local', SystemRole.Admin);
    const stale = actorOf(admin);
    await db
      .update(users)
      .set({ systemRole: SystemRole.User })
      .where(eq(users.id, admin.id));

    await expect(
      service.setSystemRole(stale, other.id, SystemRole.User),
    ).rejects.toBeInstanceOf(AccessDeniedException);

    expect(await roleOf(other.id)).toBe(SystemRole.Admin);
    expect(await entries()).toEqual([]);
  });

  // Each passed the guard as an admin. Whichever change lands second finds
  // its caller revoked, so one of them is left to undo it.
  it('lets only one of two admins revoke the other', async () => {
    const other = await person('other@campus.local', SystemRole.Admin);

    const results = await Promise.allSettled([
      service.setSystemRole(actorOf(admin), other.id, SystemRole.User),
      service.setSystemRole(actorOf(other), admin.id, SystemRole.User),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const roles = [await roleOf(admin.id), await roleOf(other.id)].sort();
    expect(roles).toEqual([SystemRole.Admin, SystemRole.User]);
  });

  it('changes and records nothing when the role is already held', async () => {
    const ada = await person('ada@campus.local');

    await expect(
      service.setSystemRole(actorOf(admin), ada.id, SystemRole.User),
    ).resolves.toMatchObject({ systemRole: SystemRole.User });

    expect(await entries()).toEqual([]);
  });

  describe('a super admin', () => {
    let root: typeof users.$inferSelect;

    beforeEach(async () => {
      root = await person('root@campus.local', SystemRole.SuperAdmin);
    });

    it.each([SystemRole.User, SystemRole.Admin] as const)(
      'cannot be set to %s, by an admin or by another super admin',
      async (role) => {
        const second = await person(
          'root2@campus.local',
          SystemRole.SuperAdmin,
        );

        for (const actor of [admin, second]) {
          await expect(
            service.setSystemRole(actorOf(actor), root.id, role),
          ).rejects.toBeInstanceOf(SystemRoleLockedException);
        }
        expect(await roleOf(root.id)).toBe(SystemRole.SuperAdmin);
        expect(await entries()).toEqual([]);
      },
    );

    it('may grant and revoke admin like any other admin', async () => {
      const ada = await person('ada@campus.local');

      await service.setSystemRole(actorOf(root), ada.id, SystemRole.Admin);
      expect(await roleOf(ada.id)).toBe(SystemRole.Admin);

      await service.setSystemRole(actorOf(root), ada.id, SystemRole.User);
      expect(await roleOf(ada.id)).toBe(SystemRole.User);
    });
  });

  it.each([SystemRole.User, SystemRole.Admin] as const)(
    'refuses an admin setting their own role to %s',
    async (role) => {
      await expect(
        service.setSystemRole(actorOf(admin), admin.id, role),
      ).rejects.toBeInstanceOf(SystemRoleLockedException);
      expect(await roleOf(admin.id)).toBe(SystemRole.Admin);
    },
  );

  it('404s a user that does not exist', async () => {
    await expect(
      service.setSystemRole(
        actorOf(admin),
        '99999999-9999-4999-8999-999999999999',
        SystemRole.Admin,
      ),
    ).rejects.toBeInstanceOf(UserNotFoundException);
  });
});
