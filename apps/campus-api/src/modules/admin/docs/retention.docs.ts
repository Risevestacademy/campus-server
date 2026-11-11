import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { SweepRetentionResponseDto } from '../dto/sweep-retention.dto.js';

export function ApiSweepRetention(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Delete rows past their retention period (super admin only)',
      description:
        'Deletes read notifications older than `NOTIFICATION_RETENTION_DAYS` ' +
        '(90 by default) and audit-log entries older than ' +
        '`AUDIT_LOG_RETENTION_DAYS` (365). Unread notifications are kept at ' +
        'any age.\n\n' +
        'Send `table` to sweep one table only, and `retentionDays` with it ' +
        'for a one-off period. No period may be under 30 days.\n\n' +
        'Each table is swept in a transaction of its own, which also writes ' +
        'a `retention_swept` audit entry. Nothing runs this on a timer: call ' +
        'it daily or weekly from an external scheduler.',
    }),
    ApiOkResponse({ type: SweepRetentionResponseDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        '`table` is not a known table, `retentionDays` is under 30 or not a ' +
        'whole number, or `retentionDays` was sent without `table`.',
    }),
    ApiUnauthorizedResponse({
      type: ApiErrorResponseDto,
      description:
        'No usable session: none sent, unparseable, expired, provisional, or ' +
        'its account is gone or suspended.',
    }),
    ApiForbiddenResponse({
      type: ApiErrorResponseDto,
      description:
        'Signed in, but not a super admin. A plain admin is refused.',
      examples: {
        notSuperAdmin: {
          summary: 'Admin or ordinary member',
          value: {
            error: { code: 'FORBIDDEN', message: 'Super admin role required' },
          },
        },
      },
    }),
  );
}
