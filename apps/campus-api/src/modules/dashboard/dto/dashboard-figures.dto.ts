import { IsOptional, IsUUID } from 'class-validator';

export class DashboardFiguresQueryDto {
  /**
   * One cohort’s figures. Left out, the whole campus.
   * @example 22222222-2222-4222-8222-222222222222
   */
  @IsOptional()
  @IsUUID()
  cohortId?: string;
}

export class MembersByRoleDto {
  /** @example 30 */
  student!: number;

  /** @example 2 */
  professor!: number;

  /** @example 4 */
  mentor!: number;

  /** @example 3 */
  guest!: number;
}

export class MemberFiguresDto {
  /**
   * People with a live membership, suspended accounts included, as on the
   * roster. Across the campus, somebody in two cohorts counts once.
   * @example 38
   */
  total!: number;

  /**
   * People with a live membership in each cohort role. Across the campus,
   * somebody holding two roles counts under both, so these can add up to more
   * than `total`.
   */
  byRole!: MembersByRoleDto;
}

export class DashboardFiguresDto {
  members!: MemberFiguresDto;

  /**
   * Invites still waiting for an answer: pending and not yet expired. Across
   * the campus this includes admin invites, which name no cohort.
   * @example 7
   */
  pendingInvites!: number;
}
