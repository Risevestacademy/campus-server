import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';

import { ApiAdminOnly } from '../../../shared/dto/admin-route.docs.js';
import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { ApiPaginatedResponse } from '../../../shared/dto/index.js';
import { UserSystemRoleDto } from '../dto/system-role.dto.js';
import { UserListItemDto } from '../dto/user-list-item.dto.js';

export function ApiListUsers(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'List users (admin only)',
      description:
        'Every account, newest first, paginated, each with its live roster ' +
        'memberships.\n\n' +
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
        'names no cohort or track is an empty page, not a 404.\n\n' +
        'Memberships describe the roster, not access. A suspended account ' +
        'is listed with its memberships and matches the membership filters, ' +
        'but cannot sign in. `status=active` narrows a list to the people ' +
        'who can.',
    }),
    ApiPaginatedResponse(UserListItemDto),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'A filter is malformed: not a UUID, or not one of the enum.',
    }),
    ApiAdminOnly(),
  );
}

export function ApiSetSystemRole(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Grant or revoke the admin role (admin only)',
      description:
        'Send `admin` to make somebody an admin, `user` to make them an ' +
        'ordinary user again. Any admin may do either.\n\n' +
        'A grant takes effect on the person’s next request if they are ' +
        'signed in. Somebody signed out, or still answering an invitation, ' +
        'has it from their next sign-in. Revoking the role also signs the ' +
        'person out everywhere.\n\n' +
        'Two people are off limits, both answered with a 409:\n\n' +
        '- **A super admin.** Their role cannot be changed through the API ' +
        'in either direction. Super admins are the accounts in ' +
        '`DEFAULT_ADMIN_EMAIL`, set by the seed.\n' +
        '- **Yourself.** Ask another admin, so nobody locks themselves out ' +
        'by a slip.\n\n' +
        'Setting the role somebody already has succeeds and changes ' +
        'nothing. `super_admin` is not an accepted value.',
    }),
    ApiOkResponse({ type: UserSystemRoleDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        'The id is not a UUID, or systemRole is not `user` or `admin`.',
    }),
    ApiAdminOnly(),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No user has this id.',
    }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description: 'The target is a super admin, or is the caller.',
      content: {
        'application/json': {
          examples: {
            superAdmin: {
              summary: 'The target is a super admin',
              value: {
                error: {
                  code: 'CONFLICT',
                  message: "A super admin's role cannot be changed",
                  details: { userId: '22222222-2222-4222-8222-222222222222' },
                },
              },
            },
            self: {
              summary: 'The target is the caller',
              value: {
                error: {
                  code: 'CONFLICT',
                  message: 'You cannot change your own role: ask another admin',
                  details: { userId: '22222222-2222-4222-8222-222222222222' },
                },
              },
            },
          },
        },
      },
    }),
  );
}
