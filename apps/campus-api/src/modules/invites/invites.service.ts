import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  isNotNull,
  lte,
  ne,
  or,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import type { PaginatedResponseDto } from '../../shared/dto/paginated-response.dto.js';
import {
  isLiveMembership,
  isNotLiveMembership,
} from '../cohorts/cohort-members.service.js';
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
import type {
  AdminInviteListItemDto,
  ListInvitesQueryDto,
} from './dto/invite-admin-list.dto.js';
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
import type { InvitePreviewResponseDto } from './dto/invite-preview.dto.js';
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
  ref: InviteRef,
) {
  const message = `This invite is already ${invite.status}`;
  const details = { ...ref, status: invite.status };

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
 * How an error names the invite it is about. Routes behind a session name it
 * by id; the public preview names nothing, since its callers hold only a
 * link and its contract carries no ids.
 */
type InviteRef = { inviteId: string } | Record<string, never>;

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
    {
      inviteId: invite.id,
      inviteEmail: invite.email,
      accountEmail: user.email,
    },
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

  /** The receipt without emailStatus, which InviteMailer adds after. */
  async create(
    dto: CreateInviteDto,
    inviter: AuthenticatedUser,
  ): Promise<Omit<InviteResponseDto, 'emailStatus'>> {
    const email = dto.email.trim().toLowerCase();
    const systemRole = dto.systemRole ?? SystemRole.User;

    this.assertValidShape(dto);

    await this.assertNoLiveInvite(email);
    await this.assertReferencesExist(dto);
    await this.assertNotAlreadyMember(email, dto.cohortId);

    const guestAccessExpiresAt = this.resolveGuestExpiry(dto);
    // An invite must not stay redeemable past the visit it grants. Without
    // this an admin could set a window ending tomorrow while the link lived
    // for INVITE_TTL_DAYS: accepting on day three would mint a full-access
    // session against a membership that was already over, and the guest
    // would be refused at their next sign-in having just been let in.
    const expiresAt = earliest(
      this.resolveExpiresAt(dto.expiresAt),
      guestAccessExpiresAt,
    );

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
            guestAccessExpiresAt,
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
          guestAccessExpiresAt: row.guestAccessExpiresAt?.toISOString() ?? null,
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
  /**
   * Whether an invite exists and is addressed to this address, whatever its
   * status. For a caller naming an invite: one that is not theirs is
   * answered as not found, so its existence is not revealed.
   */
  async isAddressedTo(inviteId: string, email: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: invites.id })
      .from(invites)
      .where(
        and(
          eq(invites.id, inviteId),
          eq(invites.email, email.trim().toLowerCase()),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

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
          guestAccessExpiresAt: invites.guestAccessExpiresAt,
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
    await this.assertLive(row.invite, inviteId, { inviteId }, now);

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
      guestAccessExpiresAt: row.invite.guestAccessExpiresAt,
      invitedBy,
      createdAt: row.invite.createdAt,
      user: account,
    };
  }

  /**
   * What the invitation screen shows before anyone has signed in, looked up
   * by the raw token from the link — the one thing that proves the caller was
   * sent it. Answers only for a live invite, with the same codes the
   * signed-in read uses, so the screen can say "expired" or "already
   * accepted" before sending anyone to Google.
   *
   * Public, so it carries no ids: nothing here is a handle to act on, only
   * what the invitee needs to recognise the offer and pick the right account.
   */
  async previewByToken(
    rawToken: string,
    now: Date = new Date(),
  ): Promise<InvitePreviewResponseDto> {
    const [row] = await this.db
      .select({
        invite: {
          id: invites.id,
          email: invites.email,
          cohortRole: invites.cohortRole,
          systemRole: invites.systemRole,
          status: invites.status,
          expiresAt: invites.expiresAt,
          guestAccessExpiresAt: invites.guestAccessExpiresAt,
        },
        cohort: {
          name: cohorts.name,
          code: cohorts.code,
          startDate: cohorts.startDate,
          endDate: cohorts.endDate,
        },
        track: { name: tracks.name, code: tracks.code },
        inviter: { firstName: users.firstName, lastName: users.lastName },
      })
      .from(invites)
      .leftJoin(cohorts, eq(cohorts.id, invites.cohortId))
      .leftJoin(cohortTracks, eq(cohortTracks.id, invites.cohortTrackId))
      .leftJoin(tracks, eq(tracks.id, cohortTracks.trackId))
      .innerJoin(users, eq(users.id, invites.invitedBy))
      .where(eq(invites.tokenHash, hashInviteToken(rawToken)))
      .limit(1);

    if (!row) {
      // Never the token itself in details: they are returned to the caller
      // and land in the error log.
      throw new InviteNotFoundException('No invite matches this link');
    }

    await this.assertLive(row.invite, row.invite.id, {}, now);

    return {
      email: row.invite.email,
      cohort: row.cohort,
      track: row.track,
      cohortRole: row.invite.cohortRole,
      systemRole: row.invite.systemRole,
      invitedBy: row.inviter,
      expiresAt: row.invite.expiresAt,
      guestAccessExpiresAt: row.invite.guestAccessExpiresAt,
    };
  }

  /**
   * Throws unless the invite can still be answered. isInviteLive is the
   * single source of truth; the branches only explain which of its two
   * conditions failed.
   */
  private async assertLive(
    invite: { status: InviteStatus; expiresAt: Date },
    inviteId: string,
    ref: InviteRef,
    now: Date,
  ): Promise<void> {
    if (isInviteLive(invite, now)) {
      return;
    }
    // Lapsed-but-still-pending and already-materialised Expired are one
    // outcome with one code. The first read is what does the materialising,
    // so anything else would make the answer depend on how many times the
    // invite had been looked at — which the caller cannot see.
    if (
      invite.status === InviteStatus.Pending ||
      invite.status === InviteStatus.Expired
    ) {
      if (invite.status === InviteStatus.Pending) {
        await this.expireLazily(inviteId, now);
      }
      throw new InviteForbiddenException('This invite has expired', {
        ...ref,
        expiresAt: invite.expiresAt,
      });
    }
    throw terminalInviteException(invite, ref);
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
   * Explains a failed claim. It only reports: the row is left as it is, so a
   * lapsed invite refused here keeps its pending status until something that
   * reads it materialises the lapse.
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

    throw terminalInviteException(invite, { inviteId });
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
      // An admin invite: a platform role rather than a place in a cohort.
      // Guests do enrol — theirs is a cohort role like any other.
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

    // create() clamps expires_at to the window, so a live invite should imply
    // a live window. Checked anyway: the alternative is writing a membership
    // that is dead on arrival, which reads as a successful accept and then
    // refuses the guest at their very next sign-in.
    if (
      invite.guestAccessExpiresAt !== null &&
      invite.guestAccessExpiresAt <= now
    ) {
      throw new InviteForbiddenException('This guest visit has already ended', {
        inviteId: invite.id,
        guestAccessExpiresAt: invite.guestAccessExpiresAt,
      });
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
        accessExpiresAt: invite.guestAccessExpiresAt,
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
          // Whatever ended the last membership is not true of this one. The
          // reason is discarded rather than carried forward — see
          // cohort_members_dismissal_reason, which refuses to hold one on a
          // row that is not dismissed. Preserving why somebody once left is
          // audit_log's job; until that exists the reason is lost here, and
          // personal/backlog.md records that it has to be written there
          // first once it does.
          dismissalReason: null,
          accessExpiresAt: invite.guestAccessExpiresAt,
          leftAt: null,
          joinedAt: now,
          updatedAt: now,
        },
        // Only a membership that is no longer live may be revived. A live one
        // is a standing decision — its role, track and joinedAt belong to
        // whoever made it, and an invite sent before it must not rewrite
        // them.
        //
        // This is the exact negation of what the sign-in gate calls live, and
        // shares its definition deliberately. Spelling the rule out twice is
        // what produced the lockouts: a row that does not let somebody in,
        // but does block the invite meant to bring them back, leaves them
        // with no way through at all. That covers a guest whose visit ended
        // with left_at still NULL, and a student left dismissed, deferred or
        // unclassified without anybody setting left_at.
        setWhere: isNotLiveMembership(now),
      })
      .returning();

    if (!row) {
      const live = await this.findMembership(tx, invite.cohortId, userId);
      if (live) {
        // The transaction rolls back, so the invite stays answerable: an
        // admin can revoke it, or the member can be removed first.
        throw new InviteConflictException(
          'This account is already a member of that cohort',
          { inviteId: invite.id, cohortId: invite.cohortId, userId },
        );
      }
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
   *
   * It only ever grants. An invite is an offer made at some point in the
   * past, and the account may have been promoted since it was sent — writing
   * the invite's role over the current one would let a stale ordinary invite
   * demote an admin.
   */
  private async applySystemRole(
    tx: Tx,
    invite: Invite,
    userId: string,
  ): Promise<User> {
    if (invite.systemRole !== SystemRole.Admin) {
      return this.findAccount(tx, userId);
    }

    const [raised] = await tx
      .update(users)
      .set({ systemRole: SystemRole.Admin })
      .where(and(eq(users.id, userId), ne(users.systemRole, SystemRole.Admin)))
      .returning();

    if (raised) {
      return raised;
    }
    // Already carried — skip the write rather than bump updatedAt for nothing.
    return this.findAccount(tx, userId);
  }

  private async findMembership(
    tx: Tx,
    cohortId: string,
    userId: string,
  ): Promise<typeof cohortMembers.$inferSelect | undefined> {
    const [row] = await tx
      .select()
      .from(cohortMembers)
      .where(
        and(
          eq(cohortMembers.cohortId, cohortId),
          eq(cohortMembers.userId, userId),
        ),
      )
      .limit(1);
    return row;
  }

  private async findAccount(tx: Tx, userId: string): Promise<User> {
    const [row] = await tx
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) {
      throw new InviteInternalException('Signed-in account vanished', {
        userId,
      });
    }
    return row;
  }

  /** A visit that ended before it began is not an invite anybody can use. */
  private resolveGuestExpiry(dto: CreateInviteDto): Date | null {
    if (dto.guestAccessExpiresAt == null) {
      return null;
    }
    const at = new Date(dto.guestAccessExpiresAt);
    if (Number.isNaN(at.getTime())) {
      throw new InviteInvalidArgumentException(
        'guestAccessExpiresAt is not a valid date',
      );
    }
    if (at.getTime() <= Date.now()) {
      throw new InviteInvalidArgumentException(
        'guestAccessExpiresAt must be in the future',
      );
    }
    return at;
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
  private async expireLazily(
    id: string,
    now: Date = new Date(),
  ): Promise<void> {
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
   * instead of a raw constraint violation. Two shapes pass through: cohort
   * ({ email, cohortId, cohortRole }, plus guestAccessExpiresAt when that role
   * is guest) and admin ({ email, systemRole: admin }) — anything the CHECKs
   * would reject is caught here first.
   */
  private assertValidShape(dto: CreateInviteDto): void {
    const hasCohortId = dto.cohortId != null;
    const hasCohortRole = dto.cohortRole != null;
    const hasScopedField =
      dto.cohortTrackId != null || dto.mentorshipGroupId != null;

    // invites_cohortless_is_admin: everybody else joins a cohort, guests
    // included — a guest is invited to one cohort and sees that cohort.
    if (!hasCohortId && dto.systemRole !== SystemRole.Admin) {
      throw new InviteInvalidArgumentException(
        'Only an admin invite may omit a cohort; every other invite names one',
        { systemRole: dto.systemRole ?? SystemRole.User },
      );
    }
    // invites_guest_has_expiry: a visit has an end, and only a visit does.
    if (
      dto.cohortRole === CohortRole.Guest &&
      dto.guestAccessExpiresAt == null
    ) {
      throw new InviteInvalidArgumentException(
        'guestAccessExpiresAt is required when cohortRole is guest',
      );
    }
    if (
      dto.cohortRole !== CohortRole.Guest &&
      dto.guestAccessExpiresAt != null
    ) {
      throw new InviteInvalidArgumentException(
        'guestAccessExpiresAt belongs to guest invites only',
        { cohortRole: dto.cohortRole ?? null },
      );
    }
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
      where: and(
        eq(invites.email, email),
        eq(invites.status, InviteStatus.Pending),
      ),
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

  /**
   * An admin cancelling an offer they no longer want to honour.
   *
   * Revoked, not expired: the invite did not run out of time, somebody pulled
   * it. That is why the actor and the moment are written alongside the status
   * flip — an expired invite has nobody to blame, a revoked one does.
   *
   * Only a live pending invite can be revoked, and the claim is the same
   * conditional UPDATE accept and decline use: one row matches
   * `status='pending' AND expires_at > now`, so two admins revoking the same
   * invite cannot both win, and the loser is diagnosed from the row it re-reads
   * rather than overwriting the winner. An invite that lapsed between the
   * admin's click and this write is reported as expired and is never converted
   * into a revocation — the admin wanted to stop an offer that had already
   * stopped on its own, and saying so is more useful than recording a
   * cancellation nobody made.
   *
   * Once revoked the invite is invisible to sign-in and reads as
   * INVITE_REVOKED to anybody already holding it mid-onboarding. The address
   * is free to be invited again: the one-live-per-address index only covers
   * pending rows, so this is the step POST /invites asks for before a
   * re-invite.
   */
  async revoke(
    inviteId: string,
    actor: AuthenticatedUser,
    now: Date = new Date(),
  ): Promise<AdminInviteListItemDto> {
    const [revoked] = await this.db.transaction((tx) =>
      tx
        .update(invites)
        .set({
          status: InviteStatus.Revoked,
          revokedAt: now,
          revokedBy: actor.id,
        })
        .where(
          and(
            eq(invites.id, inviteId),
            eq(invites.status, InviteStatus.Pending),
            // Same comparison isInviteLive makes, so a lapsed invite is
            // refused here exactly as it is on the read path.
            gt(invites.expiresAt, now),
          ),
        )
        .returning(),
    );

    if (revoked) {
      return toAdminInviteItem(revoked);
    }

    // Nothing was claimed. Materialise the lapse on the read side first, so
    // the record says expired rather than leaving a stale pending row for the
    // next reader to trip over, then explain which of the settled states this
    // was.
    const existing = await this.findInvite(inviteId);
    await this.expireLazily(inviteId, now);
    return this.throwUnrevocable(existing, inviteId);
  }

  /**
   * Explains a failed revoke claim, reusing the terminal-state mapping accept
   * and decline already answer with, so one settled invite has one answer
   * whichever route asked about it. Revoking an already-revoked invite is
   * therefore a 409 rather than a silent success: the caller asked to stop an
   * offer that is already stopped, and that is a disagreement about the state
   * worth surfacing rather than papering over with a 200.
   */
  private async throwUnrevocable(
    invite: Invite,
    inviteId: string,
  ): Promise<never> {
    // Pending-but-lapsed and already-expired are one outcome, so they share a
    // code: reporting them differently would make the response depend on
    // whether something had read the invite first, which the caller cannot
    // see. expireLazily above has already flipped the pending one.
    if (
      invite.status === InviteStatus.Pending ||
      invite.status === InviteStatus.Expired
    ) {
      throw new InviteForbiddenException('This invite has expired', {
        inviteId,
        expiresAt: invite.expiresAt,
      });
    }

    throw terminalInviteException(invite, { inviteId });
  }

  /**
   * The row for this id, or nothing. A missing invite is a 404 rather than an
   * empty result: the caller named an invite that does not exist, which is a
   * different mistake from naming one that has already settled.
   */
  private async findInvite(inviteId: string): Promise<Invite> {
    const [invite] = await this.db
      .select()
      .from(invites)
      .where(eq(invites.id, inviteId))
      .limit(1);

    if (!invite) {
      throw new InviteNotFoundException('No invite matches this id', {
        inviteId,
      });
    }
    return invite;
  }

  /**
   * One page of invites, newest first.
   *
   * The admin's view of the offers they have out, and the only place a
   * revoked invite stays visible — sign-in cannot find one, so without this
   * "who revoked that address" would have no answer at all.
   *
   * Rows are projected, never returned whole: the full invite carries
   * token_hash and the raw token is derived from it, so a list must not hand
   * out hashes any more than it hands out tokens.
   */
  async list(
    query: ListInvitesQueryDto,
  ): Promise<PaginatedResponseDto<AdminInviteListItemDto>> {
    const filter =
      query.status === undefined ? undefined : eq(invites.status, query.status);

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(invites)
        .where(filter)
        .orderBy(desc(invites.createdAt), asc(invites.id))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      this.db.select({ total: count() }).from(invites).where(filter),
    ]);

    return {
      items: rows.map(toAdminInviteItem),
      meta: {
        page: query.page,
        perPage: query.perPage,
        total,
        totalPages: Math.ceil(total / query.perPage),
      },
    };
  }

  /**
   * An invite to a cohort somebody already belongs to could never be
   * accepted — accept refuses to overwrite a live membership — yet it would
   * stay pending, and sign-in sends a member with a pending invite to answer
   * it. So it is refused here, where the admin can see why. A membership that
   * has ended (left, dismissed, a visit over) is no obstacle: the invite is
   * how somebody is brought back. Other cohorts are no obstacle either; a
   * person can belong to several.
   */
  private async assertNotAlreadyMember(
    email: string,
    cohortId: string | undefined,
  ): Promise<void> {
    if (!cohortId) return;
    const [live] = await this.db
      .select({ userId: cohortMembers.userId })
      .from(cohortMembers)
      .innerJoin(users, eq(users.id, cohortMembers.userId))
      .where(
        and(
          eq(users.email, email),
          eq(cohortMembers.cohortId, cohortId),
          isLiveMembership(new Date()),
        ),
      )
      .limit(1);
    if (live) {
      throw new InviteConflictException(
        `${email} is already a member of this cohort`,
        { email, cohortId },
      );
    }
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
      throw new InviteInvalidArgumentException(
        'expiresAt must be in the future',
      );
    }
    return at.getTime() > max.getTime() ? max : at;
  }
}

type InviteWriteErrorKind = 'pending-duplicate' | 'token-collision' | null;

/** The earlier of two moments, ignoring a null second one. */
function earliest(a: Date, b: Date | null): Date {
  return b !== null && b < a ? b : a;
}

function toMembershipDto(row: CohortMember): MembershipGrantedDto {
  return {
    cohortId: row.cohortId,
    role: row.role,
    cohortTrackId: row.cohortTrackId,
    status: row.status,
    joinedAt: row.joinedAt,
    accessExpiresAt: row.accessExpiresAt,
  };
}

/**
 * Projects an invite row down to what an admin is allowed to see in a list.
 *
 * Named fields rather than a spread, so a column added to INVITES later is
 * withheld by default instead of leaking until someone notices. That matters
 * here more than usual: token_hash is a credential, and any future secret
 * column added for a good reason would ride out in every admin list.
 *
 * Timestamps cross the wire as ISO strings rather than Date, matching
 * InviteResponseDto and the rest of the invites responses.
 */
function toAdminInviteItem(row: Invite): AdminInviteListItemDto {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    cohortId: row.cohortId,
    cohortRole: row.cohortRole,
    systemRole: row.systemRole,
    expiresAt: row.expiresAt.toISOString(),
    invitedBy: row.invitedBy,
    revokedBy: row.revokedBy,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
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
