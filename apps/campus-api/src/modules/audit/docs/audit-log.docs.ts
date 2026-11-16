import { applyDecorators } from '@nestjs/common';
import { ApiBadRequestResponse, ApiOperation } from '@nestjs/swagger';

import { ApiAdminOnly } from '../../../shared/dto/admin-route.docs.js';
import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { ApiPaginatedResponse } from '../../../shared/dto/index.js';
import { AuditLogEntryDto } from '../dto/list-audit-log.dto.js';

export function ApiListAuditLog(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'List audit entries (admin only)',
      description:
        'Who changed what: the admin setup (cohorts, tracks, invites) and ' +
        'the changes to people’s access that follow from it. Newest first, ' +
        'paginated. Read-only: entries cannot be edited or removed.\n\n' +
        'Filters are all optional and combine with AND. `subjectType` and ' +
        '`subjectId` together are one thing’s history. `from` and `to` are ' +
        'a half-open range: `from` is included, `to` is not.\n\n' +
        'History starts when the log was introduced. An empty history for ' +
        'something older does not mean nothing happened to it. An id that ' +
        'names nothing is an empty page, not a 404.\n\n' +
        'Sign-ins, reads, and accepting or declining an invite are not ' +
        'recorded, except where an accept revives a membership or grants ' +
        'the admin role.',
    }),
    ApiPaginatedResponse(AuditLogEntryDto),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        'A filter is malformed: not a UUID, not one of the enum, not a date ' +
        'or a timestamp with a zone, or `to` is not after `from`.',
    }),
    ApiAdminOnly(),
  );
}
