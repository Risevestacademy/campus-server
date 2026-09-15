import { pgEnum, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export enum SystemRole {
  User = 'user',
  Admin = 'admin',
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
    systemRole: systemRoleEnum('system_role').notNull().default(SystemRole.User),
    status: userStatusEnum('status').notNull().default(UserStatus.Active),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;