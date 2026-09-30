import { sql } from 'drizzle-orm';

import { SystemRole, UserStatus, users } from '../../modules/users/schema.js';
import type { Db } from './database.constants.js';

export interface SeedLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
}

export type SeedOutcome = 'created' | 'promoted' | 'unchanged';

/**
 * Seeds each admin in turn. One at a time rather than in one statement, so
 * the log says what happened to each address — which of two admins was new
 * and which was already there.
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

  const [row] = await db
    .insert(users)
    .values({
      email: address,
      systemRole: SystemRole.Admin,
      status: UserStatus.Active,
    })
    .onConflictDoUpdate({
      target: users.email,
      // updated_at is set explicitly built in hook only fires for db.update()
      set: { systemRole: SystemRole.Admin, updatedAt: sql`now()` },
      // Skip the write when the user is already an admin, so re-running the
      setWhere: sql`${users.systemRole} <> ${SystemRole.Admin}`,
    })
    .returning({
      id: users.id,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    });

  if (!row) {
    logger.info(
      { email: address },
      'admin user already present, nothing to do',
    );
    return 'unchanged';
  }

  const outcome =
    row.createdAt.getTime() === row.updatedAt.getTime()
      ? 'created'
      : 'promoted';
  logger.info(
    { email: address, userId: row.id },
    outcome === 'created'
      ? 'seeded admin user'
      : 'promoted existing user to admin',
  );
  return outcome;
}
