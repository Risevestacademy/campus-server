import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import {
  DRIZZLE,
  type Db,
} from '../../infra/database/database.constants.js';
import { CohortRole, cohorts, cohortTracks } from '../cohorts/schema.js';
import { SystemRole } from '../users/schema.js';
import type { CreateInviteDto } from './dto/create-invite.dto.js';
import type { InviteResponseDto } from './dto/invite-response.dto.js';
import {
  buildInviteLink,
  generateInviteToken,
  hashInviteToken,
} from './invite-token.js';
import {
  InviteConflictException,
  InviteInvalidArgumentException,
  InviteNotFoundException,
} from './invites.exceptions.js';
import { InviteStatus, invites } from './schema.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';

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
 * Stale pending rows whose expires_at has passed are auto-flipped to
 * 'expired' so a lapsed invite never blocks a re-invite forever.
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

    this.assertValidShape(dto, systemRole);

    await this.assertNoLiveInvite(email);
    await this.assertReferencesExist(dto);

    const expiresAt = this.resolveExpiresAt(dto.expiresAt);
    const token = generateInviteToken();
    const tokenHash = hashInviteToken(token);

    let row;
    try {
      [row] = await this.db
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
    } catch (err) {
      // Race guard: two concurrent creates for the same email — the partial
      // unique index decides, and we translate it to the documented 409.
      if (isPendingConflict(err)) {
        throw new InviteConflictException(
          `A pending invite already exists for ${email}`,
          { email },
        );
      }
      throw err;
    }

    if (!row) {
      throw new InviteInvalidArgumentException('Invite could not be created');
    }

    const inviteLink = buildInviteLink(this.appPublicUrl, token);
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
  }

  private get appPublicUrl(): string {
    return (
      this.config.APP_PUBLIC_URL ??
      this.config.INVITE_LINK_BASE_URL ??
      'http://localhost:3000'
    );
  }

  private get inviteTtlDays(): number {
    return this.config.INVITE_TTL_DAYS ?? 7;
  }

  /**
   * Enforces the two accepted shapes before the DB CHECKs fire, so callers
   * get a clean 400 INVALID_ARGUMENT instead of a raw constraint violation.
   */
  private assertValidShape(dto: CreateInviteDto, systemRole: SystemRole): void {
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

    const isCohortInvite = hasCohortId && hasCohortRole;
    const isAdminInvite =
      systemRole === SystemRole.Admin && !hasCohortId && !hasCohortRole;

    if (!isCohortInvite && !isAdminInvite) {
      throw new InviteInvalidArgumentException(
        'Invite must be either { email, cohortId, cohortRole } or { email, systemRole: admin }',
      );
    }
  }

  private async assertNoLiveInvite(email: string): Promise<void> {
    const existing = await this.db.query.invites.findFirst({
      where: and(eq(invites.email, email), eq(invites.status, InviteStatus.Pending)),
    });
    if (!existing) return;

    if (existing.expiresAt.getTime() <= Date.now()) {
      await this.db
        .update(invites)
        .set({ status: InviteStatus.Expired })
        .where(eq(invites.id, existing.id));
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
    if (raw) {
      const at = new Date(raw);
      if (Number.isNaN(at.getTime())) {
        throw new InviteInvalidArgumentException('expiresAt is not a valid date');
      }
      if (at.getTime() <= Date.now()) {
        throw new InviteInvalidArgumentException('expiresAt must be in the future');
      }
      return at;
    }
    return new Date(Date.now() + this.inviteTtlDays * 86_400_000);
  }
}

function isPendingConflict(err: unknown): boolean {
  const message =
    err instanceof Error
      ? `${err.message} ${String((err as { cause?: unknown }).cause ?? '')}`
      : String(err);
  return (
    message.includes('invites_email_pending_unique') ||
    message.includes('invites_token_hash_unique')
  );
}
