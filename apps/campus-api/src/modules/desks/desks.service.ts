import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, or } from 'drizzle-orm';

import {
  DRIZZLE,
  type Db,
  type DbExecutor,
} from '../../infra/database/database.constants.js';
import { isUniqueViolation } from '../../infra/database/unique-violation.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { writeAuditEntry, type AuditContext } from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType } from '../audit/schema.js';
import { isLiveMembership } from '../cohorts/cohort-members.service.js';
import { CohortNotFoundException } from '../cohorts/cohorts.exceptions.js';
import { CohortRole, cohortMembers, cohorts } from '../cohorts/schema.js';
import { maps } from '../maps/schema.js';
import { UserStatus, hasAdminPowers, users } from '../users/schema.js';
import {
  DeskConflictException,
  DeskForbiddenException,
  DeskNotFoundException,
} from './desks.exceptions.js';
import type { DeskDto } from './dto/desk.dto.js';
import { endDeskClaims, tellDesksChanged } from './end-claims.js';
import { DeskReleaseReason, deskClaims, desks } from './schema.js';

type Purpose = 'view' | 'claim' | 'release';

interface LiveDesk {
  id: string;
  key: string;
  mapKey: string;
}

/**
 * Who holds which desk in a cohort, and claiming and letting go of one.
 *
 * Anybody with a live place in the cohort, and any admin, sees the desks.
 * Any admin, and any live member but a guest, may claim one; claiming a
 * second desk in the same cohort moves them to it. A holder lets go of
 * their own desk; only an admin frees somebody else's.
 */
@Injectable()
export class DesksService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Every desk on the published maps, with its holder in this cohort. */
  async list(
    viewer: AuthenticatedUser,
    cohortId: string,
    now: Date = new Date(),
  ): Promise<DeskDto[]> {
    await admit(this.db, viewer, cohortId, 'view', now);
    const rows = await this.db
      .select({
        key: desks.key,
        mapKey: maps.key,
        holderId: deskClaims.userId,
        displayName: users.displayName,
        claimedAt: deskClaims.claimedAt,
      })
      .from(desks)
      .innerJoin(maps, eq(maps.id, desks.mapId))
      .leftJoin(
        deskClaims,
        and(
          eq(deskClaims.deskId, desks.id),
          eq(deskClaims.cohortId, cohortId),
          isNull(deskClaims.releasedAt),
        ),
      )
      .leftJoin(users, eq(users.id, deskClaims.userId))
      .where(isNull(desks.retiredAt))
      .orderBy(asc(maps.key), asc(desks.key));
    return rows.map(toDto);
  }

  /**
   * Claims a desk for the caller. Claiming the one they hold changes
   * nothing; claiming another ends their claim on the first.
   *
   * The desk is read under a share lock, so a map sync retiring it waits for
   * this, or this for the sync, which then finds no desk. A member's
   * membership is read under one too, so ending it waits for the claim and
   * then ends it. Two claims racing for one desk, or one person's two
   * claims racing each other, meet on the unique indexes: the loser is a
   * 409.
   */
  async claim(
    user: AuthenticatedUser,
    cohortId: string,
    key: string,
    now: Date = new Date(),
  ): Promise<DeskDto> {
    try {
      return await this.db.transaction(async (tx) => {
        await admit(tx, user, cohortId, 'claim', now);
        const desk = await liveDesk(tx, key);

        const open = await tx
          .select()
          .from(deskClaims)
          .where(
            and(
              eq(deskClaims.cohortId, cohortId),
              isNull(deskClaims.releasedAt),
              or(
                eq(deskClaims.deskId, desk.id),
                eq(deskClaims.userId, user.id),
              ),
            ),
          )
          .for('update');
        const onDesk = open.find((claim) => claim.deskId === desk.id);
        if (onDesk && onDesk.userId !== user.id) {
          throw new DeskConflictException('Somebody else holds that desk', {
            cohortId,
            key,
          });
        }
        if (!onDesk) {
          const mine = open.find((claim) => claim.userId === user.id);
          if (mine) {
            await endDeskClaims(
              tx,
              eq(deskClaims.id, mine.id),
              DeskReleaseReason.Released,
              now,
              { notify: false },
            );
          }
          await tx
            .insert(deskClaims)
            .values({ deskId: desk.id, cohortId, userId: user.id });
          await tellDesksChanged(tx, [cohortId]);
        }
        return view(tx, desk, cohortId);
      });
    } catch (err) {
      if (
        isUniqueViolation(err, 'desk_claims_one_holder') ||
        isUniqueViolation(err, 'desk_claims_one_desk')
      ) {
        throw new DeskConflictException(
          'That desk, or yours, changed hands just now. Try again.',
          { cohortId, key },
        );
      }
      throw err;
    }
  }

  /**
   * Ends the claim on a desk: the holder letting go of it, or an admin
   * freeing somebody else's, which is audited. A desk nobody holds is
   * answered as it is, so a retried release succeeds.
   */
  async release(
    user: AuthenticatedUser,
    cohortId: string,
    key: string,
    audit: AuditContext,
    now: Date = new Date(),
  ): Promise<DeskDto> {
    return this.db.transaction(async (tx) => {
      const { admin } = await admit(tx, user, cohortId, 'release', now);
      const desk = await liveDesk(tx, key);
      const [claim] = await tx
        .select()
        .from(deskClaims)
        .where(
          and(
            eq(deskClaims.deskId, desk.id),
            eq(deskClaims.cohortId, cohortId),
            isNull(deskClaims.releasedAt),
          ),
        )
        .for('update');
      if (!claim) {
        return view(tx, desk, cohortId);
      }

      if (claim.userId === user.id) {
        await endDeskClaims(
          tx,
          eq(deskClaims.id, claim.id),
          DeskReleaseReason.Released,
          now,
        );
      } else if (admin) {
        await endDeskClaims(
          tx,
          eq(deskClaims.id, claim.id),
          DeskReleaseReason.FreedByAdmin,
          now,
        );
        await writeAuditEntry(tx, {
          ...audit,
          action: AuditAction.DeskFreed,
          subject: { type: AuditSubjectType.DeskClaim, id: claim.id },
          details: { cohortId, deskKey: desk.key, holderId: claim.userId },
        });
      } else {
        throw new DeskForbiddenException(
          "Only an admin may free somebody else's desk",
          { cohortId, key },
        );
      }
      return view(tx, desk, cohortId);
    });
  }
}

/**
 * Lets an admin through on their role, once the cohort is known to exist,
 * and anybody else on a live membership of it; claiming and releasing also
 * turn guests away. The role and status are read from the account, not the
 * session.
 *
 * Claiming reads the membership and then the account under share locks, in
 * the order ending a membership takes them, so a membership ending, a
 * suspension or a demotion waits for the claim to commit and then ends it.
 * Releasing reads the account under one too, so an admin demoted meanwhile
 * cannot free a desk on the role they lost.
 */
async function admit(
  db: DbExecutor,
  user: AuthenticatedUser,
  cohortId: string,
  purpose: Purpose,
  now: Date,
): Promise<{ admin: boolean }> {
  const membership = db
    .select({ role: cohortMembers.role })
    .from(cohortMembers)
    .where(
      and(
        eq(cohortMembers.cohortId, cohortId),
        eq(cohortMembers.userId, user.id),
        isLiveMembership(now),
      ),
    );
  const [member] =
    purpose === 'claim' ? await membership.for('share') : await membership;

  const accountQuery = db
    .select({ systemRole: users.systemRole, status: users.status })
    .from(users)
    .where(eq(users.id, user.id));
  const [account] =
    purpose === 'view' ? await accountQuery : await accountQuery.for('share');
  if (!account || account.status === UserStatus.Suspended) {
    throw new DeskForbiddenException('This account may not use desks', {
      cohortId,
    });
  }

  if (hasAdminPowers(account.systemRole)) {
    const [cohort] = await db
      .select({ id: cohorts.id })
      .from(cohorts)
      .where(eq(cohorts.id, cohortId))
      .limit(1);
    if (!cohort) {
      throw new CohortNotFoundException(`No cohort with id ${cohortId}`, {
        cohortId,
      });
    }
    return { admin: true };
  }

  if (!member) {
    throw new DeskForbiddenException(
      "Only the cohort's live members and admins may use its desks",
      { cohortId },
    );
  }
  if (purpose !== 'view' && member.role === CohortRole.Guest) {
    throw new DeskForbiddenException('Guests cannot hold a desk', {
      cohortId,
    });
  }
  return { admin: false };
}

/** The desk by key, under a share lock, or a 404 when it is not on a map. */
async function liveDesk(db: DbExecutor, key: string): Promise<LiveDesk> {
  const [desk] = await db
    .select({ id: desks.id, key: desks.key, mapKey: maps.key })
    .from(desks)
    .innerJoin(maps, eq(maps.id, desks.mapId))
    .where(and(eq(desks.key, key), isNull(desks.retiredAt)))
    .for('share', { of: desks });
  if (!desk) {
    throw new DeskNotFoundException(`No desk "${key}" on the map`, { key });
  }
  return desk;
}

async function view(
  db: DbExecutor,
  desk: LiveDesk,
  cohortId: string,
): Promise<DeskDto> {
  const [row] = await db
    .select({
      holderId: deskClaims.userId,
      displayName: users.displayName,
      claimedAt: deskClaims.claimedAt,
    })
    .from(deskClaims)
    .innerJoin(users, eq(users.id, deskClaims.userId))
    .where(
      and(
        eq(deskClaims.deskId, desk.id),
        eq(deskClaims.cohortId, cohortId),
        isNull(deskClaims.releasedAt),
      ),
    );
  return toDto({ key: desk.key, mapKey: desk.mapKey, ...row });
}

function toDto(row: {
  key: string;
  mapKey: string;
  holderId?: string | null;
  displayName?: string | null;
  claimedAt?: Date | null;
}): DeskDto {
  return {
    key: row.key,
    mapKey: row.mapKey,
    holder: row.holderId
      ? { id: row.holderId, displayName: row.displayName ?? null }
      : null,
    claimedAt: row.claimedAt ?? null,
  };
}
