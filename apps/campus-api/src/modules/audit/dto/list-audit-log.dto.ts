import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsUUID,
  Matches,
  ValidateBy,
  type ValidationOptions,
} from 'class-validator';

import { PaginationQueryDto } from '../../../shared/dto/pagination-query.dto.js';
import { AuditAction, AuditSubjectType } from '../schema.js';

/**
 * A day, read as midnight UTC, or an instant that says which zone it is in.
 * A timestamp with no zone would be read in whatever zone the server runs
 * in, so it is refused rather than guessed at.
 */
const DATE_OR_ZONED_INSTANT =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

/**
 * Later than the instant in `property`. Passes when either is absent or
 * unparseable, leaving the other rules to report it.
 */
function IsAfter(
  property: string,
  options?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isAfter',
      constraints: [property],
      validator: {
        validate: (value: unknown, args) => {
          const object = args?.object as Record<string, unknown> | undefined;
          const other = object?.[property];
          if (typeof value !== 'string' || typeof other !== 'string') {
            return true;
          }
          const [end, start] = [Date.parse(value), Date.parse(other)];
          return Number.isNaN(end) || Number.isNaN(start) || end > start;
        },
        defaultMessage: (args) => `${args?.property} must be after ${property}`,
      },
    },
    options,
  );
}

/** Pagination plus the filters, every one optional and combined with AND. */
export class ListAuditLogQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: AuditAction, enumName: 'AuditAction' })
  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  @ApiPropertyOptional({
    format: 'uuid',
    example: '22222222-2222-4222-8222-222222222222',
    description: 'Entries written by this account.',
  })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @ApiPropertyOptional({
    enum: AuditSubjectType,
    enumName: 'AuditSubjectType',
    description: 'Entries about this kind of thing.',
  })
  @IsOptional()
  @IsEnum(AuditSubjectType)
  subjectType?: AuditSubjectType;

  @ApiPropertyOptional({
    format: 'uuid',
    example: '44444444-4444-4444-8444-444444444444',
    description:
      'Entries about the thing with this id. Send `subjectType` as well ' +
      'for one thing’s history.',
  })
  @IsOptional()
  @IsUUID()
  subjectId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    example: '2026-10-01T00:00:00.000Z',
    description:
      'Entries written at or after this instant. A bare date ' +
      '(`2026-10-01`) is midnight UTC; a timestamp must carry its zone.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(DATE_OR_ZONED_INSTANT, {
    message: 'from must be a date or a timestamp with a zone',
  })
  from?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    example: '2026-10-08T00:00:00.000Z',
    description:
      'Entries written before this instant, which is left out, so ranges ' +
      'placed end to end never count an entry twice. All of 7 October is ' +
      '`from=2026-10-07&to=2026-10-08`. Must be after `from`.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(DATE_OR_ZONED_INSTANT, {
    message: 'to must be a date or a timestamp with a zone',
  })
  @IsAfter('from')
  to?: string;
}

/**
 * One entry as an admin reads it. Named fields rather than the row:
 * `space_id` is reserved and nothing writes it yet.
 */
export class AuditLogEntryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'The account that did it. Null when no person did: the seed, a ' +
      'migration. Not always an admin: an invitee is the actor when they ' +
      'flag an invite or accept one.',
  })
  actorUserId: string | null;

  @ApiProperty({ enum: AuditAction, enumName: 'AuditAction' })
  action: string;

  @ApiProperty({
    enum: AuditSubjectType,
    enumName: 'AuditSubjectType',
    nullable: true,
  })
  subjectType: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Not checked against anything: the thing may since have been deleted.',
  })
  subjectId: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    example: { name: 'Software Engineering', code: 'SE' },
    description:
      'What the action records beyond its subject. The shape is fixed per ' +
      '`action`; dates are ISO 8601 strings. Ids of people, never ' +
      'addresses or names — except free text an admin wrote about a ' +
      'person: `membership_revived.previous.dismissalReason` and ' +
      '`user_suspended.reason`.',
  })
  details: Record<string, unknown> | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The request’s correlation id, which leads to its log lines. Null ' +
      'for entries written outside a request. Caller-supplied text: a ' +
      'pointer, not proof.',
  })
  correlationId: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-10-07T09:30:00.000Z',
    description: 'When the change committed.',
  })
  createdAt: Date;
}
