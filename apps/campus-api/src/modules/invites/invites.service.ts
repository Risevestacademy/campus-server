import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import {
  DRIZZLE,
  type Db,
} from '../../infra/database/database.constants.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
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

  private get inviteTtlDays(): number {
    return this.config.INVITE_TTL_DAYS ?? 7;
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
