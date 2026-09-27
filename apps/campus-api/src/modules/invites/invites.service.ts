import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, lte } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import {
  DRIZZLE,
  type Db,
} from '../../infra/database/database.constants.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CohortRole, cohorts, cohortTracks } from '../cohorts/schema.js';
import { tracks } from '../tracks/schema.js';
import { SystemRole, users } from '../users/schema.js';
import type { CreateInviteDto } from './dto/create-invite.dto.js';
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
  InviteConflictException,
  InviteForbiddenException,
  InviteInternalException,
  InviteInvalidArgumentException,
  InviteNotFoundException,
} from './invites.exceptions.js';
import { InviteStatus, invites } from './schema.js';

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
      throw new InviteConflictException(
        `This invite is already ${row.invite.status}`,
        { inviteId, status: row.invite.status },
      );
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
