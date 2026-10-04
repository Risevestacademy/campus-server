import { eq, sql } from 'drizzle-orm';

import { writeAuditEntry } from '../../modules/audit/audit-log.js';
import { AuditAction, AuditSubjectType } from '../../modules/audit/schema.js';
import { SystemRole, UserStatus, users } from '../../modules/users/schema.js';
import type { Db } from './database.constants.js';

export interface SeedLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
}

export type SeedOutcome = 'created' | 'promoted' | 'unchanged';

/**
 * Seeds each super admin in turn: the accounts in DEFAULT_ADMIN_EMAIL. The
 * seed is the only thing that grants the role, and nothing takes it away, so
 * an address removed from the list stays a super admin until somebody
 * changes the row by hand.
 *
 * One at a time rather than in one statement, so the log says what happened
 * to each address — which of two was new and which was already there.
 */
export async function seedAdmins(
  db: Db,
  emails: readonly string[],
  logger: SeedLogger,
): Promise<Record<string, SeedOutcome>> {
  const outcomes: Record<string, SeedOutcome> = {};
  for (const email of emails) {
    outcomes[email.trim().toLowerCase()] = await seedAdmin(db, email, logger);
  }
  return outcomes;
}

export async function seedAdmin(
  db: Db,
  email: string,
  logger: SeedLogger,
): Promise<SeedOutcome> {
  const address = email.trim().toLowerCase();

  // One transaction, so the role is never granted without its audit entry.
  const seeded = await db.transaction(async (tx) => {
    // What the role was, for the entry. An account seeded before the super
    // admin role existed is an admin; one somebody signed up with is a
    // user. Read without a lock: the upsert below is what decides the write,
    // so two deploys seeding at once still produce one account.
    const [before] = await tx
      .select({ systemRole: users.systemRole })
      .from(users)
      .where(eq(users.email, address))
      .limit(1);

    const [row] = await tx
      .insert(users)
      .values({
        email: address,
        systemRole: SystemRole.SuperAdmin,
        status: UserStatus.Active,
      })
      .onConflictDoUpdate({
        target: users.email,
        // updated_at is set explicitly built in hook only fires for db.update()
        set: { systemRole: SystemRole.SuperAdmin, updatedAt: sql`now()` },
        // Skip the write when the account is already a super admin, so
        // re-running the seed changes nothing and records nothing.
        setWhere: sql`${users.systemRole} <> ${SystemRole.SuperAdmin}`,
      })
      .returning({ id: users.id });

    if (row) {
      await writeAuditEntry(tx, {
        // Nobody is signed in: the grant comes from DEFAULT_ADMIN_EMAIL.
        actorUserId: null,
        action: AuditAction.SystemRoleChanged,
        subject: { type: AuditSubjectType.User, id: row.id },
        details: {
          // A new account had no role before.
          from: before?.systemRole ?? null,
          to: SystemRole.SuperAdmin,
          source: 'seed',
        },
      });
    }
    // Whether the account was there is read from `before`, not guessed from
    // its timestamps: an account created and seeded within the same
    // millisecond would otherwise pass for new.
    return row ? { id: row.id, created: before === undefined } : null;
  });

  if (!seeded) {
    logger.info(
      { email: address },
      'super admin already present, nothing to do',
    );
    return 'unchanged';
  }

  const outcome = seeded.created ? 'created' : 'promoted';
  logger.info(
    { email: address, userId: seeded.id },
    outcome === 'created'
      ? 'seeded super admin'
      : 'promoted existing account to super admin',
  );
  return outcome;
}
