import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsOptional, IsUUID } from 'class-validator';

import {
  MembershipState,
  RosterScope,
} from '../../cohorts/dto/cohort-roster.dto.js';
import { CohortRole, StudentStatus } from '../../cohorts/schema.js';
import { UserStatus } from '../../users/schema.js';

/** `json` (the default) to read on screen; `csv` to download. */
export enum ReportFormat {
  Json = 'json',
  Csv = 'csv',
}

export class ReportCohortParamDto {
  /** @example 11111111-1111-4111-8111-111111111111 */
  @IsUUID()
  cohortId: string;
}

/** What every report takes. All optional, combined with AND. */
class ReportQueryDto {
  @ApiPropertyOptional({
    enum: ReportFormat,
    enumName: 'ReportFormat',
    default: ReportFormat.Json,
  })
  @IsOptional()
  @IsEnum(ReportFormat)
  format: ReportFormat = ReportFormat.Json;

  /**
   * `all` (the default) for everybody who has held a place, `live` for the
   * people in the cohort now, `ended` for those whose membership ended. The
   * same rule as the roster.
   */
  @ApiPropertyOptional({
    enum: RosterScope,
    enumName: 'RosterScope',
    default: RosterScope.All,
  })
  @IsOptional()
  @IsEnum(RosterScope)
  state: RosterScope = RosterScope.All;

  /**
   * Members on this catalogue track, as on the roster.
   * @example 33333333-3333-4333-8333-333333333333
   */
  @IsOptional()
  @IsUUID()
  trackId?: string;
}

export class MembershipReportQueryDto extends ReportQueryDto {
  @ApiPropertyOptional({ enum: CohortRole, enumName: 'CohortRole' })
  @IsOptional()
  @IsEnum(CohortRole)
  role?: CohortRole;
}

export class AttendanceReportQueryDto extends ReportQueryDto {
  /**
   * Classes starting at or after this instant.
   * @example 2026-11-01T00:00:00.000Z
   */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  /**
   * Classes starting before this instant.
   * @example 2026-12-01T00:00:00.000Z
   */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}

/** The cohort a report is about. */
export class ReportCohortDto {
  /** @example 11111111-1111-4111-8111-111111111111 */
  id: string;

  /** @example C1 */
  code: string;

  /** @example "Cohort 1" */
  name: string;
}

/** Who a row is about, and their place in the cohort. */
export class ReportMemberDto {
  /**
   * The membership: one per person per cohort.
   * @example 77777777-7777-4777-8777-777777777777
   */
  membershipId: string;

  /** @example 22222222-2222-4222-8222-222222222222 */
  userId: string;

  /** @example ada@campus.local */
  email: string;

  /** @example Ada */
  firstName: string | null;

  /** @example Lovelace */
  lastName: string | null;

  /** @example "Ada L." */
  displayName: string | null;

  @ApiProperty({ enum: CohortRole, enumName: 'CohortRole' })
  role: CohortRole;

  /** @example SE */
  trackCode: string | null;

  /** @example "Software Engineering" */
  trackName: string | null;

  /** Students only; null for every other role. */
  @ApiProperty({
    enum: StudentStatus,
    enumName: 'StudentStatus',
    nullable: true,
  })
  studentStatus: StudentStatus | null;

  /** Whether the membership counts now, read against the clock. */
  @ApiProperty({ enum: MembershipState, enumName: 'MembershipState' })
  state: MembershipState;
}

export class MembershipReportRowDto extends ReportMemberDto {
  /** A suspended account keeps its place but cannot sign in. */
  @ApiProperty({ enum: UserStatus, enumName: 'UserStatus' })
  accountStatus: UserStatus;

  /** @example 2026-09-22T12:00:00.000Z */
  joinedAt: Date;

  leftAt: Date | null;

  /** Why the membership was ended, when an admin wrote a reason. */
  @ApiProperty({ example: null })
  endReason: string | null;

  /** Guests only: when the visit ends. */
  accessExpiresAt: Date | null;
}

export class MembershipReportDto {
  cohort: ReportCohortDto;

  /** @example 2026-11-22T09:00:00.000Z */
  generatedAt: Date;

  /** Staff, then students, then guests; by name within each. */
  @ApiProperty({ type: () => [MembershipReportRowDto] })
  rows: MembershipReportRowDto[];
}

export class AttendanceReportRowDto extends ReportMemberDto {
  /**
   * Tallied classes in the range this student was expected at.
   * @example 12
   */
  classes: number;

  /** @example 9 */
  present: number;

  /** @example 2 */
  partial: number;

  /** @example 1 */
  absent: number;

  /**
   * How many of those statuses staff corrected.
   * @example 1
   */
  corrected: number;

  /**
   * Time in the class's call across those classes, as measured.
   * @example 32400
   */
  presentSeconds: number;

  /**
   * The length of those classes added up.
   * @example 43200
   */
  possibleSeconds: number;

  /**
   * presentSeconds as a share of possibleSeconds, rounded down, as the
   * attendance reads give it. Null with no classes.
   * @example 75
   */
  @ApiProperty({ type: Number, nullable: true, example: 75 })
  percentage: number | null;
}

export class AttendanceReportDto {
  cohort: ReportCohortDto;

  /** @example 2026-11-22T09:00:00.000Z */
  generatedAt: Date;

  /** The range asked for; null for an end left open. */
  from: Date | null;
  to: Date | null;

  /** By name. */
  @ApiProperty({ type: () => [AttendanceReportRowDto] })
  rows: AttendanceReportRowDto[];
}
