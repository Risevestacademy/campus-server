import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, lte, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import {
  DRIZZLE,
  type Db,
} from '../../infra/database/database.constants.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import {
  CohortRole,
  cohortMembers,
  cohorts,
  cohortTracks,
  StudentStatus,
  type CohortMember,
} from '../cohorts/schema.js';
import { tracks } from '../tracks/schema.js';
import { SystemRole, users, type User } from '../users/schema.js';
import type { CreateInviteDto } from './dto/create-invite.dto.js';
import {
  InviteDecision,
  type InviteDecisionResponseDto,
  type MembershipGrantedDto,
} from './dto/invite-decision.dto.js';
import type {
  InvitedByDto,
  InviteCohortDto,
  InviteCohortTrackDto,
  InviteInviteeDto,
  InviteOnboardingResponseDto,
  InviteTrackDto,
} from './dto/invite-onboarding-response.dto.js';
import type { InviteResponseDto } from './dto/invite-response.dto.js';
import {
  buildInviteLink,
  generateInviteToken,
  hashInviteToken,
} from './invite-token.js';
import {
  InviteAlreadyAcceptedException,
  InviteAlreadyDeclinedException,
  InviteConflictException,
  InviteForbiddenException,
  InviteRevokedException,
  InviteInternalException,
  InviteInvalidArgumentException,
  InviteNotFoundException,
} from './invites.exceptions.js';
import { InviteStatus, invites, type Invite } from './schema.js';

/** The transaction handle drizzle hands a `db.transaction` callback. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Accept carries the account so the route can mint an upgraded session from
 * the row that was just written; decline carries nothing, because there is no
 * session left to upgrade.
 */
export type DecisionOutcome =
  | { kind: 'accepted'; response: InviteDecisionResponseDto; account: User }
  | { kind: 'declined'; response: InviteDecisionResponseDto };

/**
 * The exception for an invite that already carries an answer, chosen by which
 * answer it is.
 *
 * Deliberately shared by the decision route and the validation route: the same
 * fact about the same invite has to report the same code whichever endpoint
 * noticed it, or a caller that validated before deciding would see two
 * different codes for one state.
 */
function terminalInviteException(
  invite: { status: InviteStatus },
  inviteId: string,
) {
  const message = `This invite is already ${invite.status}`;
  const details = { inviteId, status: invite.status };

  switch (invite.status) {
    case InviteStatus.Accepted:
      return new InviteAlreadyAcceptedException(message, details);
    case InviteStatus.Declined:
      return new InviteAlreadyDeclinedException(message, details);
    case InviteStatus.Revoked:
      return new InviteRevokedException(message, details);
    default:
      return new InviteConflictException(message, details);
  }
}

/**
 * A row is live while it is still pending AND not yet lapsed.
 * expires_at is the source of truth — status flips to 'expired' lazily
 * (see below), so no reader may trust status = 'pending' on its own.
 * The future accept and listing flows must use this helper; a sweep job
 * can materialise the flip in bulk once listing exists.
 */
export function isInviteLive(
  invite: { status: InviteStatus; expiresAt: Date },
  now: Date = new Date(),
): boolean {
  return (
    invite.status === InviteStatus.Pending &&
    invite.expiresAt.getTime() > now.getTime()
  );
}

/**
 * Confirms an invite was addressed to the account presenting it.
 *
 * Both halves are server-derived — `inviteId` is signed into the session
 * cookie, and `user.email` is re-read from the USERS row on every request by
 * the guard, never taken from the token. So a disagreement is unreachable
 * from outside; it means a session was minted against the wrong invite.
 *
 * The row, not the claim: a token minted before an address change carries the
 * old one, and the codebase already decided this in session.guard.ts — "Read
 * the account from the row, never from the token".
 *
 * Throws 500 (see InviteInternalException) so the filter logs both addresses
 * and returns only its generic message to the caller.
 */
export function checkEmailMatch(
  invite: { id: string; email: string },
  user: AuthenticatedUser,
): void {
  if (invite.email === user.email) return;

  throw new InviteInternalException(
    'Session invite is not addressed to the signed-in account',
    { inviteId: invite.id, inviteEmail: invite.email, accountEmail: user.email },
  );
}

/**
 * DUPLICATE POLICY — REJECT (documented choice):
 * the schema enforces one live invite per address via the partial unique
 * index invites_email_pending_unique (WHERE status = 'pending'). This service
 * checks that slot up front and rejects a second pending invite for the same
 * email with 409 CONFLICT instead of silently reusing/rotating the old token.
 * Rationale: reusing would re-send a possibly-compromised token; rotating
 * would invalidate a link the first recipient may still hold. The admin must
 * revoke/expire the open invite first, then re-invite.
 *
 * A lapsed-but-still-pending row (expires_at passed, flip not yet
 * materialised) never blocks a re-invite: it is flipped to 'expired' on the
 * spot. A concurrent race for the same email is decided by the partial
 * unique index and translated from Postgres 23505 to the same 409.
 */
@Injectable()
export class InvitesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Env,
  ) {}

  async create(
    dto: CreateInviteDto,
    inviter: AuthenticatedUser,
  ): Promise<InviteResponseDto> {
    const email = dto.email.trim().toLowerCase();
    const systemRole = dto.systemRole ?? SystemRole.User;

    this.assertValidShape(dto);

    await this.assertNoLiveInvite(email);
    await this.assertReferencesExist(dto);

    const expiresAt = this.resolveExpiresAt(dto.expiresAt);

    // A token collision (23505 on the hash index) means regenerating, not
    // failing: the address slot is still free. Bounded to one retry — a
    // second collision in 256-bit space is not worth looping over.
    for (let attempt = 0; ; attempt++) {
      const token = generateInviteToken();
      const tokenHash = hashInviteToken(token);

      try {
        const [row] = await this.db
          .insert(invites)
          .values({
            email,
            cohortId: dto.cohortId ?? null,
            cohortTrackId: dto.cohortTrackId ?? null,
            mentorshipGroupId: dto.mentorshipGroupId ?? null,
            cohortRole: dto.cohortRole ?? null,
            systemRole,
            tokenHash,
            invitedBy: inviter.id,
            expiresAt,
          })
          .returning();

        if (!row) {
          throw new InviteInvalidArgumentException(
            'Invite could not be created',
          );
        }

        const inviteLink = buildInviteLink(this.config.APP_PUBLIC_URL, token);
        return {
          id: row.id,
          email: row.email,
          cohortId: row.cohortId,
          cohortRole: row.cohortRole,
          cohortTrackId: row.cohortTrackId,
          mentorshipGroupId: row.mentorshipGroupId,
          systemRole: row.systemRole,
          status: row.status,
          expiresAt: row.expiresAt.toISOString(),
          inviteLink,
          token,
          createdAt: row.createdAt.toISOString(),
        };
      } catch (err) {
        const kind = classifyInviteWriteError(err);
        if (kind === 'pending-duplicate') {
          throw new InviteConflictException(
            `A pending invite already exists for ${email}`,
            { email },
          );
        }
        if (kind === 'token-collision' && attempt === 0) {
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * The invite a verified address may sign in against: still pending and not
   * yet lapsed. expires_at is the source of truth, per isInviteLive — the
   * status flip is lazy, so a stale 'pending' row must not let anyone in.
   */
  async findUsableForEmail(
    email: string,
    now: Date = new Date(),
  ): Promise<typeof invites.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(invites)
      .where(
        and(
          eq(invites.email, email.trim().toLowerCase()),
          eq(invites.status, InviteStatus.Pending),
          gt(invites.expiresAt, now),
        ),
      )
      .limit(1);

    return row ?? null;
  }

  /**
   * The live invite a provisional session was minted against, with everything
   * the onboarding screen needs to render a decision.
   */
  async getOnboardingInvite(
    inviteId: string,
    user: AuthenticatedUser,
    now: Date = new Date(),
  ): Promise<InviteOnboardingResponseDto> {
    const invitee = alias(users, 'invitee');

    const [row] = await this.db
      .select({
        invite: {
          id: invites.id,
          email: invites.email,
          cohortRole: invites.cohortRole,
          systemRole: invites.systemRole,
          status: invites.status,
          expiresAt: invites.expiresAt,
          createdAt: invites.createdAt,
        },
        cohort: {
          id: cohorts.id,
          name: cohorts.name,
          code: cohorts.code,
          startDate: cohorts.startDate,
          endDate: cohorts.endDate,
          status: cohorts.status,
          createdAt: cohorts.createdAt,
          updatedAt: cohorts.updatedAt,
        },
        cohortTrack: {
          id: cohortTracks.id,
          cohortId: cohortTracks.cohortId,
          trackId: cohortTracks.trackId,
          createdAt: cohortTracks.createdAt,
        },
        track: {
          id: tracks.id,
          name: tracks.name,
          code: tracks.code,
          description: tracks.description,
          createdAt: tracks.createdAt,
          updatedAt: tracks.updatedAt,
        },
        inviter: {
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
        },
        invitee: {
          id: invitee.id,
          email: invitee.email,
          firstName: invitee.firstName,
          lastName: invitee.lastName,
          displayName: invitee.displayName,
          systemRole: invitee.systemRole,
          status: invitee.status,
          createdAt: invitee.createdAt,
        },
      })
      .from(invites)
      .leftJoin(cohorts, eq(cohorts.id, invites.cohortId))
      .leftJoin(cohortTracks, eq(cohortTracks.id, invites.cohortTrackId))
      .leftJoin(tracks, eq(tracks.id, cohortTracks.trackId))
      .innerJoin(users, eq(users.id, invites.invitedBy))
      .leftJoin(invitee, eq(invitee.id, user.id))
      .where(eq(invites.id, inviteId))
      .limit(1);

    if (!row) {
      throw new InviteNotFoundException('No invite matches this session', {
        inviteId,
      });
    }

    checkEmailMatch(row.invite, user);

    // isInviteLive is the single source of truth; the branch below only
    // explains which of its two conditions failed.
    if (!isInviteLive(row.invite, now)) {
      if (row.invite.status === InviteStatus.Pending) {
        await this.expireLazily(inviteId, now);
        throw new InviteForbiddenException('This invite has expired', {
          inviteId,
          expiresAt: row.invite.expiresAt,
        });
      }
      throw terminalInviteException(row.invite, inviteId);
    }

    const cohortRow = row.cohort;
    const cohortTrackRow = row.cohortTrack;
    const trackRow = row.track;
    const accountRow = row.invitee;

    if (!accountRow) {
      // The guard read this row a moment ago, so an absent one means a
      // concurrent delete — not a client error.
      throw new InviteInternalException(
        'Signed-in account vanished while reading its invite',
        { inviteId, userId: user.id },
      );
    }

    const cohort: InviteCohortDto | null = cohortRow
      ? {
          id: cohortRow.id,
          name: cohortRow.name,
          code: cohortRow.code,
          startDate: cohortRow.startDate,
          endDate: cohortRow.endDate,
          status: cohortRow.status,
          createdAt: cohortRow.createdAt,
          updatedAt: cohortRow.updatedAt,
        }
      : null;

    const cohortTrack: InviteCohortTrackDto | null = cohortTrackRow
      ? {
          id: cohortTrackRow.id,
          cohortId: cohortTrackRow.cohortId,
          trackId: cohortTrackRow.trackId,
          createdAt: cohortTrackRow.createdAt,
        }
      : null;

    const track: InviteTrackDto | null = trackRow
      ? {
          id: trackRow.id,
          name: trackRow.name,
          code: trackRow.code,
          description: trackRow.description,
          createdAt: trackRow.createdAt,
          updatedAt: trackRow.updatedAt,
        }
      : null;

    const invitedBy: InvitedByDto = {
      id: row.inviter.id,
      firstName: row.inviter.firstName,
      lastName: row.inviter.lastName,
    };

    const account: InviteInviteeDto = {
      id: accountRow.id,
      email: accountRow.email,
      firstName: accountRow.firstName,
      lastName: accountRow.lastName,
      displayName: accountRow.displayName,
      systemRole: accountRow.systemRole,
      status: accountRow.status,
      createdAt: accountRow.createdAt,
    };

    return {
      id: row.invite.id,
      cohort,
      cohortTrack,
      track,
      cohortRole: row.invite.cohortRole,
      systemRole: row.invite.systemRole,
      status: row.invite.status,
      expiresAt: row.invite.expiresAt,
      invitedBy,
      createdAt: row.invite.createdAt,
      user: account,
    };
  }

  /**
   * Records the invitee's answer and, on accept, everything that follows from
   * it.
   *
   * The whole of an accept is one transaction: claim the invite, enrol the
   * user, apply the role. A partial accept would either burn the invite
   * without a membership or grant a membership the invite no longer supports.
   *
   * The claim is a conditional UPDATE rather than a read-then-write. Two
   * requests racing the same invite both pass a status check, but only one can
   * match `status = 'pending' AND expires_at > now`, so the loser is diagnosed
   * from the row it re-reads rather than overwriting the winner.
   *
   * An invite that already carries an answer is a 409 rather than a silent
   * repeat, and error.code is what the caller branches on:
   * INVITE_ALREADY_ACCEPTED means sign in again to pick up the membership this
   * call would have created, while INVITE_ALREADY_DECLINED and INVITE_REVOKED
   * both mean the offer is closed. Re-running the same decision is therefore
   * never the recovery — and must not be, or a lost response would be
   * indistinguishable from a fresh decision.
   *
   * Returns the account on accept so the caller can mint the upgraded session;
   * a decline has nothing to hand back, because there is no longer a session
   * worth keeping.
   */
  async decide(
    inviteId: string,
    decision: InviteDecision,
    user: AuthenticatedUser,
    now: Date = new Date(),
  ): Promise<DecisionOutcome> {
    return decision === InviteDecision.Accept
      ? this.accept(inviteId, user, now)
      : this.decline(inviteId, user, now);
  }

  private async accept(
    inviteId: string,
    user: AuthenticatedUser,
    now: Date,
  ): Promise<DecisionOutcome> {
    return this.db.transaction(async (tx) => {
      const claimed = await this.claimInvite(
        tx,
        inviteId,
        InviteStatus.Accepted,
        { acceptedAt: now },
        now,
      );

      if (claimed.fresh) {
        checkEmailMatch(claimed.invite, user);
        const membership = await this.enrol(tx, claimed.invite, user.id, now);
        const account = await this.applySystemRole(tx, claimed.invite, user.id);
        return {
          kind: 'accepted',
          response: {
            inviteId: claimed.invite.id,
            status: InviteStatus.Accepted,
            decidedAt: claimed.invite.acceptedAt ?? now,
            membership,
            systemRole: account.systemRole,
          },
          account,
        };
      }

      return this.throwUnclaimable(claimed.invite, inviteId);
    });
  }

  private async decline(
    inviteId: string,
    user: AuthenticatedUser,
    now: Date,
  ): Promise<DecisionOutcome> {
    return this.db.transaction(async (tx) => {
      const claimed = await this.claimInvite(
        tx,
        inviteId,
        InviteStatus.Declined,
        {},
        now,
      );

      if (claimed.fresh) {
        checkEmailMatch(claimed.invite, user);
        return {
          kind: 'declined',
          response: {
            inviteId: claimed.invite.id,
            status: InviteStatus.Declined,
            decidedAt: claimed.invite.updatedAt,
            membership: null,
            systemRole: null,
          },
        };
      }

      return this.throwUnclaimable(claimed.invite, inviteId);
    });
  }

  /**
   * Moves a live pending invite to a terminal state, or reports the row that
   * stopped it. `fresh` distinguishes the request that did the moving from the
   * one that found it already moved.
   */
  private async claimInvite(
    tx: Tx,
    inviteId: string,
    status: InviteStatus.Accepted | InviteStatus.Declined,
    extra: { acceptedAt?: Date },
    now: Date,
  ): Promise<{ fresh: boolean; invite: Invite }> {
    const [claimed] = await tx
      .update(invites)
      .set({ status, ...extra })
      .where(
        and(
          eq(invites.id, inviteId),
          eq(invites.status, InviteStatus.Pending),
          // Same comparison isInviteLive makes, so a lapsed invite is refused
          // here exactly as it is on the read path.
          gt(invites.expiresAt, now),
        ),
      )
      .returning();

    if (claimed) {
      return { fresh: true, invite: claimed };
    }

    const [existing] = await tx
      .select()
      .from(invites)
      .where(eq(invites.id, inviteId))
      .limit(1);

    if (!existing) {
      throw new InviteNotFoundException('No invite matches this session', {
        inviteId,
      });
    }
    return { fresh: false, invite: existing };
  }

  /**
   * Explains a failed claim, and flips the lazy expiry on the way out when the
   * invite turned out to be lapsed rather than answered.
   */
  private async throwUnclaimable(
    invite: Invite,
    inviteId: string,
  ): Promise<never> {
    // Pending-but-lapsed and already-expired are the same outcome, so they get
    // the same code. Reporting 403 for one and 409 for the other would make
    // the response depend on whether something had read the invite first, which
    // the caller cannot see and cannot predict.
    if (
      invite.status === InviteStatus.Pending ||
      invite.status === InviteStatus.Expired
    ) {
      throw new InviteForbiddenException('This invite has expired', {
        inviteId,
        expiresAt: invite.expiresAt,
      });
    }

    throw terminalInviteException(invite, inviteId);
  }

  /**
   * Creates the membership an accepted cohort invite carries, or restores one
   * for a member who left and is being re-invited.
   *
   * A student's status is written as active rather than left null. The column
   * permits null, but CohortMembersService.hasActiveMembership only counts a
   * student whose status is active — so a null would make the accept look like
   * it worked and then fail to recognise the member on their next sign-in,
   * sending them back to the invite wall.
   */
  private async enrol(
    tx: Tx,
    invite: Invite,
    userId: string,
    now: Date,
  ): Promise<MembershipGrantedDto | null> {
    if (invite.cohortId === null) {
      // A guest invite: full access with nowhere to enrol. Not an error.
      return null;
    }
    if (invite.cohortRole === null) {
      // invites_cohort_pairing makes this unreachable; a row that breaks it
      // would fail its own insert anyway.
      throw new InviteInternalException(
        'Cohort-scoped invite has no cohort role',
        { inviteId: invite.id },
      );
    }

    const status =
      invite.cohortRole === CohortRole.Student ? StudentStatus.Active : null;

    const [row] = await tx
      .insert(cohortMembers)
      .values({
        cohortId: invite.cohortId,
        userId,
        cohortTrackId: invite.cohortTrackId,
        role: invite.cohortRole,
        status,
        joinedAt: now,
      })
      .onConflictDoUpdate({
        // cohort_members_unique: one row per person per cohort, ever, so
        // rejoining revives the existing row instead of adding a second.
        target: [cohortMembers.cohortId, cohortMembers.userId],
        set: {
          role: invite.cohortRole,
          cohortTrackId: invite.cohortTrackId,
          status,
          leftAt: null,
          joinedAt: now,
          updatedAt: now,
        },
      })
      .returning();

    if (!row) {
      throw new InviteInternalException('Membership could not be created', {
        inviteId: invite.id,
        userId,
      });
    }
    return toMembershipDto(row);
  }

  /**
   * The invite is the only channel that can grant a role above the default a
   * provisional sign-in creates the account with, because the account already
   * exists by the time anyone accepts. Applying it here is what makes
   * `systemRole` on an invite mean anything.
   */
  private async applySystemRole(
    tx: Tx,
    invite: Invite,
    userId: string,
  ): Promise<User> {
    const [raised] = await tx
      .update(users)
      .set({ systemRole: invite.systemRole })
      .where(
        and(eq(users.id, userId), ne(users.systemRole, invite.systemRole)),
      )
      .returning();

    if (raised) {
      return raised;
    }
    // Already carried — skip the write rather than bump updatedAt for nothing.
    return this.findAccount(tx, userId);
  }

  private async findAccount(tx: Tx, userId: string): Promise<User> {
    const [row] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!row) {
      throw new InviteInternalException('Signed-in account vanished', { userId });
    }
    return row;
  }

  private get inviteTtlDays(): number {
    return this.config.INVITE_TTL_DAYS ?? 7;
  }

  /**
   * Materialises the lazy flip for one invite.
   *
   * The WHERE guards on status *and* expires_at, so this can only ever move a
   * still-pending, genuinely lapsed row. Guarding on status alone would let a
   * concurrent accept that lands between the caller's read and this write be
   * clobbered back to 'expired' — unreachable while invites are only ever
   * created, reachable the moment accept exists.
   */
  private async expireLazily(id: string, now: Date = new Date()): Promise<void> {
    await this.db
      .update(invites)
      .set({ status: InviteStatus.Expired })
      .where(
        and(
          eq(invites.id, id),
          eq(invites.status, InviteStatus.Pending),
          lte(invites.expiresAt, now),
        ),
      );
  }

  /**
   * Mirrors the INVITES CHECKs so callers get a clean 400 INVALID_ARGUMENT
   * instead of a raw constraint violation. Three shapes pass through:
   * cohort ({ email, cohortId, cohortRole }), admin
   * ({ email, systemRole: admin }) and guest ({ email } alone) — anything
   * the CHECKs would reject is caught here first.
   */
  private assertValidShape(dto: CreateInviteDto): void {
    const hasCohortId = dto.cohortId != null;
    const hasCohortRole = dto.cohortRole != null;
    const hasScopedField =
      dto.cohortTrackId != null || dto.mentorshipGroupId != null;

    // invites_cohort_pairing: cohort and role travel together.
    if (hasCohortId !== hasCohortRole) {
      throw new InviteInvalidArgumentException(
        'cohortId and cohortRole must be provided together',
        { cohortId: dto.cohortId ?? null, cohortRole: dto.cohortRole ?? null },
      );
    }
    // invites_scoped_fields_require_cohort.
    if (!hasCohortId && hasScopedField) {
      throw new InviteInvalidArgumentException(
        'cohortTrackId and mentorshipGroupId require cohortId',
      );
    }
    // invites_student_requires_track.
    if (dto.cohortRole === CohortRole.Student && dto.cohortTrackId == null) {
      throw new InviteInvalidArgumentException(
        'cohortTrackId is required when cohortRole is student',
      );
    }
  }

  private async assertNoLiveInvite(email: string): Promise<void> {
    const existing = await this.db.query.invites.findFirst({
      where: and(eq(invites.email, email), eq(invites.status, InviteStatus.Pending)),
    });
    if (!existing) return;

    if (!isInviteLive(existing)) {
      await this.expireLazily(existing.id);
      return;
    }

    throw new InviteConflictException(
      `A pending invite already exists for ${email}: revoke it before re-inviting`,
      { email, inviteId: existing.id },
    );
  }

  /** Friendly 404s for bad FKs instead of raw FK violations. */
  private async assertReferencesExist(dto: CreateInviteDto): Promise<void> {
    if (dto.cohortId) {
      const cohort = await this.db.query.cohorts.findFirst({
        where: eq(cohorts.id, dto.cohortId),
      });
      if (!cohort) {
        throw new InviteNotFoundException(`Cohort ${dto.cohortId} not found`, {
          cohortId: dto.cohortId,
        });
      }
    }

    if (dto.cohortTrackId) {
      const track = await this.db.query.cohortTracks.findFirst({
        where: eq(cohortTracks.id, dto.cohortTrackId),
      });
      if (!track) {
        throw new InviteNotFoundException(
          `Cohort track ${dto.cohortTrackId} not found`,
          { cohortTrackId: dto.cohortTrackId },
        );
      }
      // invites_cohort_track_fk: the track must belong to the invite cohort.
      if (dto.cohortId && track.cohortId !== dto.cohortId) {
        throw new InviteInvalidArgumentException(
          'cohortTrackId does not belong to cohortId',
          { cohortId: dto.cohortId, cohortTrackId: dto.cohortTrackId },
        );
      }
    }
  }

  private resolveExpiresAt(raw?: string): Date {
    // No invite may outlive the configured TTL — a far-future expiresAt is
    // clamped, not rejected, so the caller still gets a working invite.
    const max = new Date(Date.now() + this.inviteTtlDays * 86_400_000);
    if (!raw) return max;

    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) {
      throw new InviteInvalidArgumentException('expiresAt is not a valid date');
    }
    if (at.getTime() <= Date.now()) {
      throw new InviteInvalidArgumentException('expiresAt must be in the future');
    }
    return at.getTime() > max.getTime() ? max : at;
  }
}

type InviteWriteErrorKind = 'pending-duplicate' | 'token-collision' | null;

function toMembershipDto(row: CohortMember): MembershipGrantedDto {
  return {
    cohortId: row.cohortId,
    role: row.role,
    cohortTrackId: row.cohortTrackId,
    status: row.status,
    joinedAt: row.joinedAt,
  };
}

/**
 * Classifies a failed INVITES insert by Postgres SQLSTATE plus constraint
 * name — never by driver prose alone. 23505 is unique_violation; the
 * constraint name tells the two indexes apart so a token collision is
 * retried while a taken address slot is a 409.
 *
 * Driver reality: drizzle wraps the driver error, so SQLSTATE and the
 * constraint live on `cause`, and the outer message is just "Failed query:
 * ...". Both levels are inspected — matching the outer message alone misses
 * every real violation.
 */
export function classifyInviteWriteError(err: unknown): InviteWriteErrorKind {
  const code =
    (err as { code?: unknown } | null)?.code ??
    (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (code !== '23505') return null;

  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth++) {
    if (typeof current === 'object') {
      const record = current as Record<string, unknown>;
      if (typeof record['message'] === 'string') parts.push(record['message']);
      if (typeof record['constraint'] === 'string') {
        parts.push(record['constraint']);
      }
      current = record['cause'];
    } else {
      parts.push(String(current));
      break;
    }
  }
  const haystack = parts.join(' ');
  if (haystack.includes('invites_email_pending_unique')) {
    return 'pending-duplicate';
  }
  if (haystack.includes('invites_token_hash_unique')) {
    return 'token-collision';
  }
  return null;
}
