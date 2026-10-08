import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import {
  DRIZZLE,
  type Db,
} from '../../../infra/database/database.constants.js';
import type { AuthenticatedUser } from '../../../shared/auth/authenticated-user.js';
import type {
  OwnProfileDto,
  ProfileCardDto,
  UpdateProfileDto,
} from './dto/profile.dto.js';
import { loadLiveMemberships } from '../live-memberships.js';
import { hasAdminPowers, UserStatus, users, type User } from '../schema.js';
import { ProfileNotFoundException } from '../users.exceptions.js';

/** The fields a person may change about themselves. */
const EDITABLE = [
  'firstName',
  'lastName',
  'displayName',
  'phone',
  'bio',
] as const;

/**
 * A person's own profile, and the card other members see of them. Apart from UsersService, which is what sign-in resolves an identity
 * with and the session layer depends on, and from UserDirectoryService,
 * which is the admin's list.
 */
@Injectable()
export class ProfileService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getOwn(userId: string, now: Date = new Date()): Promise<OwnProfileDto> {
    return this.toOwnProfile(await this.findUser(userId), now);
  }

  /**
   * Changes only the fields the request named. A field left out keeps its
   * value; one sent as null is cleared.
   */
  async updateOwn(
    userId: string,
    dto: UpdateProfileDto,
    now: Date = new Date(),
  ): Promise<OwnProfileDto> {
    const changes: Partial<Pick<User, (typeof EDITABLE)[number]>> = {};
    for (const field of EDITABLE) {
      if (dto[field] !== undefined) {
        changes[field] = dto[field];
      }
    }
    if (Object.keys(changes).length === 0) {
      return this.getOwn(userId, now);
    }

    const [row] = await this.db
      .update(users)
      .set(changes)
      .where(eq(users.id, userId))
      .returning();
    if (!row) {
      throw new ProfileNotFoundException('No such profile', { userId });
    }
    return this.toOwnProfile(row, now);
  }

  /**
   * What `viewer` may see of another person.
   *
   * Themselves and admins: always. Anybody else: only somebody they share a
   * live cohort with, and then only the cohorts they share — a member does
   * not learn where else a classmate belongs. A guest holds one cohort, so
   * this is also what keeps a guest to the cohort they were invited to.
   *
   * Everything else is a 404, whether the account is missing, suspended, or
   * simply not theirs to see.
   */
  async getCard(
    viewer: AuthenticatedUser,
    targetId: string,
    now: Date = new Date(),
  ): Promise<ProfileCardDto> {
    const notFound = () =>
      new ProfileNotFoundException('No such profile', { userId: targetId });

    const [target] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, targetId))
      .limit(1);
    if (!target) {
      throw notFound();
    }

    const seesEverything =
      viewer.id === target.id || hasAdminPowers(viewer.systemRole);

    const memberships = await loadLiveMemberships(
      this.db,
      seesEverything ? [target.id] : [target.id, viewer.id],
      now,
    );
    let shown = memberships.get(target.id) ?? [];

    if (!seesEverything) {
      // A suspended account is closed to everybody but admins.
      if (target.status === UserStatus.Suspended) {
        throw notFound();
      }
      const mine = new Set(
        (memberships.get(viewer.id) ?? []).map((m) => m.cohort.id),
      );
      shown = shown.filter((m) => mine.has(m.cohort.id));
      if (shown.length === 0) {
        throw notFound();
      }
    }

    return {
      id: target.id,
      email: target.email,
      firstName: target.firstName,
      lastName: target.lastName,
      displayName: target.displayName,
      bio: target.bio,
      avatarUrl: target.avatarUrl,
      spriteKey: target.spriteKey,
      memberships: shown.map(({ cohort, track, role }) => ({
        cohort,
        track,
        role,
      })),
    };
  }

  private async findUser(userId: string): Promise<User> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) {
      throw new ProfileNotFoundException('No such profile', { userId });
    }
    return row;
  }

  private async toOwnProfile(row: User, now: Date): Promise<OwnProfileDto> {
    const memberships = await loadLiveMemberships(this.db, [row.id], now);
    return {
      id: row.id,
      email: row.email,
      firstName: row.firstName,
      lastName: row.lastName,
      displayName: row.displayName,
      phone: row.phone,
      bio: row.bio,
      avatarUrl: row.avatarUrl,
      spriteKey: row.spriteKey,
      systemRole: row.systemRole,
      memberships: memberships.get(row.id) ?? [],
      createdAt: row.createdAt,
    };
  }
}
