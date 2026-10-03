import { applyDecorators } from '@nestjs/common';
import { ApiBadRequestResponse, ApiOperation } from '@nestjs/swagger';

import { ApiAdminOnly } from '../../../shared/dto/admin-route.docs.js';
import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { ApiPaginatedResponse } from '../../../shared/dto/index.js';
import { UserListItemDto } from '../dto/user-list-item.dto.js';

export function ApiListUsers(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'List users (admin only)',
      description:
        'Every account, newest first, paginated, each with the cohorts it ' +
        'may enter now.\n\n' +
        'Filters are all optional and combine with AND. `search` matches ' +
        'the address and the names; `systemRole` and `status` are about the ' +
        'account. `cohortId`, `trackId` and `cohortRole` are about a ' +
        'membership, and one membership has to satisfy all of those sent: ' +
        '`cohortId` + `trackId` is one cohort’s students on one track, and ' +
        '`cohortId` + `cohortRole=mentor` is that cohort’s mentors — not ' +
        'people in the cohort who mentor elsewhere.\n\n' +
        'Membership filters read live memberships only, the same rule ' +
        'sign-in uses: somebody who left, was dismissed, or whose guest ' +
        'visit ended is not in the cohort for this purpose. An id that ' +
        'names no cohort or track is an empty page, not a 404.',
    }),
    ApiPaginatedResponse(UserListItemDto),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'A filter is malformed: not a UUID, or not one of the enum.',
    }),
    ApiAdminOnly(),
  );
}
