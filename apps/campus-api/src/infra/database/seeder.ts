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
    const entry = (userId: string, from: SystemRole | null) =>
      writeAuditEntry(tx, {
        // Nobody is signed in: the grant comes from DEFAULT_ADMIN_EMAIL.
        actorUserId: null,
        action: AuditAction.SystemRoleChanged,
        subject: { type: AuditSubjectType.User, id: userId },
        details: { from, to: SystemRole.SuperAdmin, source: 'seed' },
      });

    // Twice at most: the second time round the account is known to exist.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Read under a lock, so the role the entry records is the one this
      // write replaces. Read without one, an admin changing the same account
      // in between would have their change overwritten and the entry would
      // still name the role from before it: a history of something that did
      // not happen.
      const [existing] = await tx
        .select({ id: users.id, systemRole: users.systemRole })
        .from(users)
        .where(eq(users.email, address))
        .for('update');

      if (existing) {
        // Already a super admin: re-running the seed changes nothing and
        // records nothing.
        if (existing.systemRole === SystemRole.SuperAdmin) {
          return null;
        }
        await tx
          .update(users)
          .set({ systemRole: SystemRole.SuperAdmin, updatedAt: sql`now()` })
          .where(eq(users.id, existing.id));
        // An account seeded before the super admin role existed was an
        // admin; one somebody signed up with was a user.
        await entry(existing.id, existing.systemRole);
        return { id: existing.id, created: false };
      }

      // Nobody there, so nothing to lock. If the account appears before this
      // lands — another deploy seeding, or its owner signing in — the insert
      // stands aside and the loop goes round to find it and lock it.
      const [created] = await tx
        .insert(users)
        .values({
          email: address,
          systemRole: SystemRole.SuperAdmin,
          status: UserStatus.Active,
        })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id });
      if (created) {
        // A new account had no role before.
        await entry(created.id, null);
        return { id: created.id, created: true };
      }
    }
    // The address was taken when the insert ran and gone when it was read
    // again: an account deleted in that instant. Nothing was written.
    throw new Error(`could not seed ${address}: the account kept changing`);
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
