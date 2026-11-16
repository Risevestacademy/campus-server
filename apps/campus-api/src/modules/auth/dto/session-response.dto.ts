import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SessionScope } from '@campus/session';

import { CohortRole } from '../../cohorts/schema.js';
import { SystemRole } from '../../users/schema.js';

/** The signed-in account, read from USERS on this request. */
export class SessionUserDto {
  /** @example 55555555-5555-4555-8555-555555555555 */
  id: string;

  /** @example ada@campus.local */
  email: string;

  /** @example Ada */
  @ApiPropertyOptional()
  firstName: string | null;

  /** @example Lovelace */
  @ApiPropertyOptional()
  lastName: string | null;

  /** @example "Ada Lovelace" */
  @ApiPropertyOptional()
  displayName: string | null;

  /** @example https://lh3.googleusercontent.com/a/example */
  @ApiPropertyOptional()
  avatarUrl: string | null;

  @ApiProperty({ enum: SystemRole, enumName: 'SystemRole' })
  systemRole: SystemRole;
}

/** The cohort place that admits this account today. */
export class SessionMembershipDto {
  /** @example 11111111-1111-4111-8111-111111111111 */
  cohortId: string;

  @ApiProperty({ enum: CohortRole, enumName: 'CohortRole' })
  role: CohortRole;
}

export class SessionCohortDto {
  /** @example "Cohort 3" */
  name: string;

  /** @example C3 */
  code: string;
}

/** One cohort this account may enter, labelled for a cohort picker. */
export class SessionCohortPlaceDto extends SessionMembershipDto {
  cohort: SessionCohortDto;
}

export class SessionResponseDto {
  /**
   * `full_access` belongs in the campus. `provisional` still has an invite to
   * answer, and every route but onboarding refuses it.
   */
  @ApiProperty({ enum: Object.values(SessionScope), enumName: 'SessionScope' })
  scope: SessionScope;

  /**
   * When the access token lapses. A full-access session renews it with POST
   * /v1/auth/refresh; a provisional one has to sign in again.
   * @example 2026-09-30T12:15:00.000Z
   */
  expiresAt: Date;

  /**
   * The invite to answer, if any: for a provisional session, the one it was
   * issued for, or the live invite that replaced it if that one was revoked or
   * lapsed; for a full-access session, a pending invite to another cohort. Load
   * it with GET /v1/invites/validate-user-invite.
   * @example 66666666-6666-4666-8666-666666666666
   */
  @ApiPropertyOptional()
  inviteId: string | null;

  user: SessionUserDto;

  /**
   * The first of `memberships` — only one, so it cannot describe somebody in
   * several cohorts; read `memberships` instead. Null for a provisional
   * session, and for an admin who holds no cohort place.
   */
  @ApiPropertyOptional()
  membership: SessionMembershipDto | null;

  /**
   * Every cohort this account may enter, most recently joined first — a person
   * can belong to several, in any mix of roles. Empty for a provisional session
   * and for an admin with no cohort place. `membership` is the first entry,
   * kept while clients move to this.
   */
  memberships: SessionCohortPlaceDto[];
}
