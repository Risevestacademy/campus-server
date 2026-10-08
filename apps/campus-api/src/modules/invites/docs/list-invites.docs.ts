import { applyDecorators } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';

import { ApiAdminOnly } from '../../../shared/dto/admin-route.docs.js';
import { ApiPaginatedResponse } from '../../../shared/dto/paginated-response.dto.js';
import { AdminInviteListItemDto } from '../dto/invite-admin-list.dto.js';

/**
 * OpenAPI description of the admin invite list. See ApiCreateInvite for why
 * these live apart from the routes.
 */
export function ApiListInvites(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'List invites',
      description:
        'Every invite the system has, newest first, paginated. Filter with ' +
        '`status` — `pending` for the open offers, `revoked` to see who ' +
        'cancelled what — and narrow to one intake with `cohortId`, ' +
        '`trackId`, or both.\n\n' +
        'This is the only place a revoked invite stays visible: sign-in ' +
        'cannot find one, so without this route "who revoked that address" ' +
        'would have no answer at all.\n\n' +
        'Deliberately not the same shape as POST /v1/invites. That one returns ' +
        'the raw token and shareable link, because the token is shown exactly ' +
        'once and is unrecoverable afterwards. Listing would hand every ' +
        'unredeemed token in the system to any admin who asked for page 1, so ' +
        'these rows carry ids and audit fields only.',
    }),
    ApiPaginatedResponse(AdminInviteListItemDto),
    ApiAdminOnly(),
  );
}
