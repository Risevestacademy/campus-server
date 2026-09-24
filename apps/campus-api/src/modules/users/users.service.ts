import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import type { GoogleIdentity } from './google-identity.js';
import { GoogleIdentityMismatchError } from './users.exceptions.js';
import { SystemRole, User, UserStatus, users } from './schema.js';

export const GOOGLE_PROVIDER = 'google';

/**
 * Predicates over the row, rather than an entity wrapping it: drizzle already
 * returns a typed row, and a class that copies every column to host a couple
 * of one-liners has to be kept in step with the schema for no added safety.
 */
export function isAdmin(user: User): boolean {
  return user.systemRole === SystemRole.Admin;
}

export function isSuspended(user: User): boolean {
  return user.status === UserStatus.Suspended;
}

export function hasGoogleIdentity(user: User): boolean {
  return user.provider === GOOGLE_PROVIDER && user.providerId !== null;
}

@Injectable()
export class UsersService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * The account behind a Google identity, read-only: by subject first, since
   * that is the stable identifier, then by address for a row nobody has
   * linked yet — a seeded admin, or an invitee created ahead of first login.
   * A row already bound to another subject is not a match.
   */
  async findForGoogleIdentity(identity: GoogleIdentity): Promise<User | null> {
    const bySubject = await this.findByGoogleSubject(identity.subject);
    if (bySubject) {
      return bySubject;
    }

    const [row] = await this.db
      .select()
      .from(users)
      .where(
        and(
          eq(users.email, normalize(identity.email)),
          isNull(users.providerId),
        ),
      )
      .limit(1);

    return row ?? null;
  }

  /**
   * Binds a Google identity to an account that has none, back-filling the
   * profile fields it left blank. Call it once sign-in is authorised: a
   * rejected caller must not leave their subject on somebody's row.
   */
  async linkGoogleIdentity(identity: GoogleIdentity): Promise<User | null> {
    const [linked] = await this.db
      .update(users)
      .set({
        provider: GOOGLE_PROVIDER,
        providerId: identity.subject,
        firstName: coalesce(users.firstName, identity.firstName),
        lastName: coalesce(users.lastName, identity.lastName),
        displayName: coalesce(users.displayName, identity.displayName),
        avatarUrl: coalesce(users.avatarUrl, identity.avatarUrl),
      })
      .where(
        and(eq(users.email, normalize(identity.email)), isNull(users.providerId)),
      )
      .returning();

    return linked ?? null;
  }

  async findByGoogleSubject(subject: string): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(
        and(eq(users.provider, GOOGLE_PROVIDER), eq(users.providerId, subject)),
      )
      .limit(1);

    return row ?? null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, normalize(email)))
      .limit(1);

    return row ?? null;
  }

  /**
   * Upserts on the address so two tabs finishing the same first sign-in
   * resolve to one row. `setWhere` keeps that from becoming a hand-over: an
   * address already bound to another Google subject updates nothing, and the
   * empty result is reported rather than silently returning someone else's
   * account. Workspace addresses do get reissued to new people.
   */
  async createFromGoogleIdentity(identity: GoogleIdentity): Promise<User> {
    const email = normalize(identity.email);

    const [row] = await this.db
      .insert(users)
      .values({
        email,
        provider: GOOGLE_PROVIDER,
        providerId: identity.subject,
        firstName: identity.firstName,
        lastName: identity.lastName,
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
        systemRole: SystemRole.User,
        status: UserStatus.Active,
      })
      .onConflictDoUpdate({
        target: users.email,
        set: { providerId: identity.subject, updatedAt: sql`now()` },
        setWhere: sql`${users.providerId} is null or ${users.providerId} = ${identity.subject}`,
      })
      .returning();

    if (!row) {
      throw new GoogleIdentityMismatchError(email);
    }
    return row;
  }

  async recordLogin(id: string): Promise<void> {
    await this.db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, id));
  }
}

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

function coalesce(column: unknown, value: string | null) {
  return sql<string | null>`coalesce(${column}, ${value})`;
}
