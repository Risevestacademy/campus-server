import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

import { PaginationQueryDto } from '../../../shared/dto/pagination-query.dto.js';
import { RoomLinkAudience } from '../../room-links/schema.js';
import { AttendanceSource, AttendanceStatus } from '../schema.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class AttendanceCohortParamDto {
  /** @example 11111111-1111-4111-8111-111111111111 */
  @IsUUID()
  cohortId: string;
}

export class AttendanceStudentParamDto extends AttendanceCohortParamDto {
  /** @example 22222222-2222-4222-8222-222222222222 */
  @IsUUID()
  userId: string;
}

export class AttendanceClassParamDto {
  /** @example 66666666-6666-4666-8666-666666666666 */
  @IsUUID()
  instanceId: string;
}

export class AttendanceIdParamDto {
  /** @example 77777777-7777-4777-8777-777777777777 */
  @IsUUID()
  attendanceId: string;
}

export class ListAttendanceClassesQueryDto extends PaginationQueryDto {
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

export class CorrectAttendanceDto {
  @ApiProperty({ enum: AttendanceStatus, enumName: 'AttendanceStatus' })
  @IsEnum(AttendanceStatus)
  status: AttendanceStatus;

  /**
   * Why, kept with the correction for good.
   * @example "Joined from the mobile app; confirmed with the professor"
   */
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

/** One student at one class. */
export class AttendanceRowDto {
  /** @example 77777777-7777-4777-8777-777777777777 */
  id: string;

  /** @example 22222222-2222-4222-8222-222222222222 */
  userId: string;

  /**
   * Time in the space's call during the class, as measured.
   * @example 2700
   */
  presentSeconds: number;

  /**
   * presentSeconds as a share of the class, rounded down.
   * @example 75
   */
  percentage: number;

  @ApiProperty({ enum: AttendanceStatus, enumName: 'AttendanceStatus' })
  status: AttendanceStatus;

  /** `override` once staff corrected the status; the tally then leaves it. */
  @ApiProperty({ enum: AttendanceSource, enumName: 'AttendanceSource' })
  source: AttendanceSource;
}

export class AttendanceStudentRowDto extends AttendanceRowDto {
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
}

/** One tallied run of a room link's event. */
export class AttendanceClassDto {
  /** @example 66666666-6666-4666-8666-666666666666 */
  instanceId: string;

  roomLinkId: string;

  /** @example "Design review" */
  title: string;

  @ApiProperty({ enum: RoomLinkAudience, enumName: 'RoomLinkAudience' })
  audience: RoomLinkAudience;

  cohortTrackId: string | null;
  mentorshipGroupId: string | null;

  /** @example 2026-11-05T10:00:00.000Z */
  startsAt: Date;

  /** @example 2026-11-05T11:00:00.000Z */
  endsAt: Date;

  /** Set when the class was cancelled; a class cancelled before it ended keeps only corrected rows. */
  @ApiPropertyOptional({ type: Date, nullable: true })
  cancelledAt: Date | null;

  talliedAt: Date;

  /** @example 24 */
  expected: number;

  /** @example 18 */
  present: number;

  /** @example 4 */
  partial: number;

  /** @example 2 */
  absent: number;

  /**
   * Time in the call across the expected students, as a share of the time
   * they could have been there, rounded down.
   * @example 81
   */
  percentage: number;
}

export class AttendanceClassDetailDto extends AttendanceClassDto {
  @ApiProperty({ type: () => [AttendanceStudentRowDto] })
  students: AttendanceStudentRowDto[];
}

/** One student's attendance across the classes the caller may read. */
export class StudentAttendanceSummaryDto {
  userId: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;

  /** @example 12 */
  classes: number;

  /** @example 9 */
  present: number;

  /** @example 2 */
  partial: number;

  /** @example 1 */
  absent: number;

  /**
   * Time in the call across those classes, as a share of their length,
   * rounded down.
   * @example 78
   */
  percentage: number;
}

/** One student at one class, with the class. */
export class StudentClassAttendanceDto extends AttendanceRowDto {
  instanceId: string;
  roomLinkId: string;
  title: string;

  @ApiProperty({ enum: RoomLinkAudience, enumName: 'RoomLinkAudience' })
  audience: RoomLinkAudience;

  startsAt: Date;
  endsAt: Date;
}

export class StudentAttendanceDto {
  userId: string;
  classes: number;
  present: number;
  partial: number;
  absent: number;
  percentage: number;

  /** Newest first. */
  @ApiProperty({ type: () => [StudentClassAttendanceDto] })
  runs: StudentClassAttendanceDto[];
}
