import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export enum SystemRole {
  User = 'user',
  Admin = 'admin',
  /**
   * An admin nobody can demote. Set only by the seed, from
   * DEFAULT_ADMIN_EMAIL: no route grants it and no route takes it away, so
   * there is always somebody who can make and unmake the other admins.
   */
  SuperAdmin = 'super_admin',
}

/**
 * Whether a role may do what admins do. Both admin roles may; what sets a
 * super admin apart is only that the role cannot be changed through the API.
 *
 * Asked of the role rather than compared against `admin` at each call site,
 * so a check written before the second role existed cannot quietly lock the
 * super admins out.
 */
export function hasAdminPowers(role: SystemRole): boolean {
  return role === SystemRole.Admin || role === SystemRole.SuperAdmin;
}

export enum UserStatus {
  Active = 'active',
  Suspended = 'suspended',
}

export const systemRoleEnum = pgEnum('system_role', SystemRole);
export const userStatusEnum = pgEnum('user_status', UserStatus);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email').notNull(),
    provider: varchar('provider').notNull().default('google'),
    providerId: varchar('provider_id'),
    firstName: varchar('first_name'),
    lastName: varchar('last_name'),
    displayName: varchar('display_name'),
    phone: varchar('phone'),
    bio: text('bio'),
    avatarUrl: varchar('avatar_url'),
    spriteKey: varchar('sprite_key'),
    systemRole: systemRoleEnum('system_role')
      .notNull()
      .default(SystemRole.User),
    status: userStatusEnum('status').notNull().default(UserStatus.Active),
    /**
     * Counts the times this account's sessions have been ended on purpose.
     * Every session token is signed with the value it found here, and is
     * refused once the two differ — so bumping this ends every session the
     * account holds at its next request, without waiting for a token to
     * lapse. Only ever goes up; see SessionIssuer.revokeAllSessions.
     */
    sessionEpoch: integer('session_epoch').notNull().default(0),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('users_email_unique').on(table.email),
    check('users_email_lowercase', sql`${table.email} = lower(${table.email})`),
    uniqueIndex('users_provider_provider_id_unique')
      .on(table.provider, table.providerId)
      .where(sql`${table.providerId} is not null`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
