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
import { SystemRole, UserStatus, users } from './schema.js';
import { UserStatusService } from './user-status.service.js';
import {
  AccountStatusLockedException,
  UserNotFoundException,
} from './users.exceptions.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);
const db = drizzle(new PGlite(), { schema: { users, auditLog } });
// The real issuer: ending the sessions is the suspension's work, and it
// only needs the database to do it.
const service = new UserStatusService(
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
const statusOf = async (id: string) => {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row.status;
};
const entries = () => db.select().from(auditLog);

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

let admin: typeof users.$inferSelect;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(sql`truncate audit_log, refresh_tokens, users cascade`);
  admin = await person('admin@campus.local', SystemRole.Admin);
});

describe('UserStatusService.suspend', () => {
  it('suspends an account, and records who did it and why', async () => {
    const ada = await person('ada@campus.local');

    const result = await service.suspend(
      actorOf(admin),
      ada.id,
      'Posted the answer to a live assessment',
      'corr-1',
    );

    expect(result).toEqual({
      id: ada.id,
      email: 'ada@campus.local',
      status: UserStatus.Suspended,
    });
    expect(await statusOf(ada.id)).toBe(UserStatus.Suspended);
    // On the row as well as in the log: reinstate reads it to decide who
    // may lift this.
    const row = await db.select().from(users).where(eq(users.id, ada.id));
    expect(row[0].suspendedBy).toBe(admin.id);
    expect(row[0].suspendedByRole).toBe(SystemRole.Admin);
    expect(await entries()).toEqual([
      expect.objectContaining({
        actorUserId: admin.id,
        action: AuditAction.UserSuspended,
        subjectType: AuditSubjectType.User,
        subjectId: ada.id,
        correlationId: 'corr-1',
        details: {
          reason: 'Posted the answer to a live assessment',
          actorRole: SystemRole.Admin,
        },
      }),
    ]);
  });

  it('records no reason when none was given', async () => {
    const ada = await person('ada@campus.local');

    await service.suspend(actorOf(admin), ada.id);

    expect((await entries())[0].details).toEqual({
      reason: null,
      actorRole: SystemRole.Admin,
    });
  });

  // The account is not merely marked: what it already holds has to stop
  // working now, or the suspension reaches only the next sign-in.
  it('ends the sessions the account holds', async () => {
    const ada = await person('ada@campus.local');
    await signedIn(ada.id);

    await service.suspend(actorOf(admin), ada.id);

    expect(await sessionsOf(ada.id)).toEqual({ epoch: 1, live: 0 });
  });

  it('refuses an admin suspending themselves', async () => {
    await expect(
      service.suspend(actorOf(admin), admin.id),
    ).rejects.toBeInstanceOf(AccountStatusLockedException);

    expect(await statusOf(admin.id)).toBe(UserStatus.Active);
    expect(await entries()).toEqual([]);
  });

  it('refuses an account that is already suspended, and records it once', async () => {
    const ada = await person('ada@campus.local');
    await service.suspend(actorOf(admin), ada.id, 'first');

    await expect(
      service.suspend(actorOf(admin), ada.id, 'again'),
    ).rejects.toBeInstanceOf(AccountStatusLockedException);

    expect(await entries()).toHaveLength(1);
    expect((await entries())[0].details).toEqual({
      reason: 'first',
      actorRole: SystemRole.Admin,
    });
  });

  it('lets one admin suspend another', async () => {
    const other = await person('other@campus.local', SystemRole.Admin);

    await service.suspend(actorOf(admin), other.id);

    expect(await statusOf(other.id)).toBe(UserStatus.Suspended);
    expect((await entries())[0].details).toEqual({
      reason: null,
      actorRole: SystemRole.Admin,
    });
  });

  // Otherwise one admin account could lock out every super admin and leave
  // recovery to whoever can reach the database.
  it('refuses a plain admin suspending a super admin', async () => {
    const root = await person('root@campus.local', SystemRole.SuperAdmin);
    const attempt = service.suspend(actorOf(admin), root.id);

    await expect(attempt).rejects.toBeInstanceOf(AccessDeniedException);
    await expect(attempt).rejects.toThrow(
      'A super admin is required to suspend a super admin',
    );

    expect(await statusOf(root.id)).toBe(UserStatus.Active);
    expect(await entries()).toEqual([]);
  });

  it('lets a super admin suspend a super admin', async () => {
    const root = await person('root@campus.local', SystemRole.SuperAdmin);
    const otherRoot = await person('root2@campus.local', SystemRole.SuperAdmin);

    await service.suspend(actorOf(root), otherRoot.id);

    expect(await statusOf(otherRoot.id)).toBe(UserStatus.Suspended);
    expect((await entries())[0].details.actorRole).toBe(SystemRole.SuperAdmin);
  });

  // The guard refuses a suspended caller with a 401 before any route runs,
  // so this only comes up when the caller is suspended between the guard
  // and this transaction. The row is what closes it either way.
  it('refuses a caller who is no longer active', async () => {
    const ada = await person('ada@campus.local');
    const stale = actorOf(admin);
    await db
      .update(users)
      .set({ status: UserStatus.Suspended })
      .where(eq(users.id, admin.id));

    const attempt = service.suspend(stale, ada.id);

    await expect(attempt).rejects.toBeInstanceOf(AccessDeniedException);
    await expect(attempt).rejects.toThrow('Your account is not active');

    expect(await statusOf(ada.id)).toBe(UserStatus.Active);
    expect(await entries()).toEqual([]);
  });

  // The guard read the caller's role before the change began. By the time
  // it runs they may have been demoted themselves: the row decides.
  it('refuses a caller who is no longer an admin, whatever their request said', async () => {
    const ada = await person('ada@campus.local');
    const stale = actorOf(admin);
    await db
      .update(users)
      .set({ systemRole: SystemRole.User })
      .where(eq(users.id, admin.id));

    await expect(service.suspend(stale, ada.id)).rejects.toBeInstanceOf(
      AccessDeniedException,
    );

    expect(await statusOf(ada.id)).toBe(UserStatus.Active);
    expect(await entries()).toEqual([]);
  });

  it('404s a user that does not exist', async () => {
    await expect(
      service.suspend(actorOf(admin), '99999999-9999-4999-8999-999999999999'),
    ).rejects.toBeInstanceOf(UserNotFoundException);
  });
});

describe('UserStatusService.reinstate', () => {
  let ada: typeof users.$inferSelect;

  beforeEach(async () => {
    ada = await person('ada@campus.local');
    await signedIn(ada.id);
    await service.suspend(actorOf(admin), ada.id, 'Posted the answer');
  });

  it('puts a suspended account back, and records it', async () => {
    const result = await service.reinstate(actorOf(admin), ada.id, 'corr-2');

    expect(result).toEqual({
      id: ada.id,
      email: 'ada@campus.local',
      status: UserStatus.Active,
    });
    expect(await statusOf(ada.id)).toBe(UserStatus.Active);
    // Who suspended it is spent: back to null, with the audit entry left
    // holding it.
    const row = await db.select().from(users).where(eq(users.id, ada.id));
    expect(row[0].suspendedBy).toBeNull();
    expect(row[0].suspendedByRole).toBeNull();
    const written = await entries();
    expect(written).toHaveLength(2);
    expect(written[1]).toMatchObject({
      actorUserId: admin.id,
      action: AuditAction.UserReinstated,
      subjectType: AuditSubjectType.User,
      subjectId: ada.id,
      correlationId: 'corr-2',
      details: {
        actorRole: SystemRole.Admin,
        suspendedBy: admin.id,
        suspendedByRole: SystemRole.Admin,
      },
    });
  });

  // Restoring the status does not hand back what the suspension took: the
  // person signs in again, on a fresh epoch.
  it('leaves the sessions it ended where they are', async () => {
    await service.reinstate(actorOf(admin), ada.id);

    expect(await sessionsOf(ada.id)).toEqual({ epoch: 1, live: 0 });
    expect(await statusOf(ada.id)).toBe(UserStatus.Active);
  });

  it('refuses an account that is not suspended', async () => {
    await service.reinstate(actorOf(admin), ada.id);

    await expect(
      service.reinstate(actorOf(admin), ada.id),
    ).rejects.toBeInstanceOf(AccountStatusLockedException);

    expect(await statusOf(ada.id)).toBe(UserStatus.Active);
    const written = await entries();
    expect(written).toHaveLength(2);
    expect(written[1].action).toBe(AuditAction.UserReinstated);
  });

  it('404s a user that does not exist', async () => {
    await expect(
      service.reinstate(actorOf(admin), '99999999-9999-4999-8999-999999999999'),
    ).rejects.toBeInstanceOf(UserNotFoundException);
  });

  it('refuses a plain admin lifting a suspension a super admin made', async () => {
    const root = await person('root@campus.local', SystemRole.SuperAdmin);
    const bea = await person('bea@campus.local');
    await service.suspend(actorOf(root), bea.id, 'a super admin decided this');

    const attempt = service.reinstate(actorOf(admin), bea.id);
    await expect(attempt).rejects.toBeInstanceOf(AccessDeniedException);
    await expect(attempt).rejects.toThrow(
      'A super admin is required to lift this suspension',
    );

    expect(await statusOf(bea.id)).toBe(UserStatus.Suspended);
    const refused = await entries();
    expect(refused).toHaveLength(2);
    expect(refused[1].action).toBe(AuditAction.UserSuspended);

    // A super admin may reinstate anybody.
    await service.reinstate(actorOf(root), bea.id);

    expect(await statusOf(bea.id)).toBe(UserStatus.Active);
    expect(await entries()).toHaveLength(3);
  });

  // The role recorded is the one the suspender held then, so promoting them
  // afterwards does not turn an ordinary suspension into a super-admin-only
  // one.
  it('lifts what a plain admin suspended, whatever rank that admin holds now', async () => {
    await db
      .update(users)
      .set({ systemRole: SystemRole.SuperAdmin })
      .where(eq(users.id, admin.id));
    const other = await person('other@campus.local', SystemRole.Admin);

    await service.reinstate(actorOf(other), ada.id);

    expect(await statusOf(ada.id)).toBe(UserStatus.Active);
    expect((await entries())[1]).toMatchObject({
      actorUserId: other.id,
      details: {
        actorRole: SystemRole.Admin,
        suspendedBy: admin.id,
        suspendedByRole: SystemRole.Admin,
      },
    });
  });
});
