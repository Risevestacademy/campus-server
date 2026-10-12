import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';

import { ApiAdminOnly } from '../../../shared/dto/admin-route.docs.js';
import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { ApiPaginatedResponse } from '../../../shared/dto/index.js';
import { UserSystemRoleDto } from '../dto/system-role.dto.js';
import { UserListItemDto } from '../dto/user-list-item.dto.js';
import { UserStatusDto } from '../dto/user-status.dto.js';

/**
 * The 403 on the two status routes, which says more than the one
 * ApiAdminOnly documents: besides "not an admin", an admin who may not make
 * this change — the wrong rank for it, or no longer active. Declared after
 * ApiAdminOnly so the two descriptions merge in the document instead of one
 * replacing the other.
 *
 * The examples are top-level, not inside `content`: with a `type` set, Nest
 * Swagger rebuilds `content` from the type when the document is made and
 * takes `content` with it, so an example placed there never reaches the
 * document at all.
 */
function ApiStatusForbidden(
  examples: Record<string, { summary: string; value: unknown }>,
): MethodDecorator {
  return ApiForbiddenResponse({
    type: ApiErrorResponseDto,
    description:
      'These routes also refuse an admin: one whose rank is not high ' +
      'enough for the change, or whose own account is no longer active.',
    examples: {
      notAdmin: {
        summary: 'Ordinary member',
        value: {
          error: { code: 'FORBIDDEN', message: 'Admin role required' },
        },
      },
      notActive: {
        summary: 'The caller is no longer active',
        value: {
          error: { code: 'FORBIDDEN', message: 'Your account is not active' },
        },
      },
      ...examples,
    },
  });
}

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

export function ApiSuspendUser(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Suspend an account (admin only)',
      description:
        'Takes an account out of service. From the next request it cannot ' +
        'sign in or call the API, its sessions end now rather than when ' +
        'their tokens run out, and an open `world` socket closes on the ' +
        'next heartbeat.\n\n' +
        'The account keeps its cohorts and its role; only its status ' +
        'changes, and it lasts until an admin reinstates it. Suspending ' +
        'records who suspended it and the role they held then, which is ' +
        'what decides who may reinstate it.\n\n' +
        'Who may suspend whom: a super admin may suspend anybody but ' +
        'themselves, so a compromised root account can still be taken out ' +
        'by another; a plain admin may suspend anybody but themselves and ' +
        'super admins, so no single admin account can lock out every super ' +
        'admin and leave recovery to the database.\n\n' +
        'Refusals: a 409 for **yourself** — ask another admin, so nobody ' +
        'locks themselves out by a slip — and for **an account already ' +
        'suspended**, which has nothing left to do. A 403 for a plain ' +
        'admin acting on a super admin, for a caller whose own account is ' +
        'no longer active, and for a caller who is not an admin.\n\n' +
        '`reason` is optional, and is kept in the audit log beside the ' +
        'actor and the target — nowhere else on the account.',
    }),
    ApiOkResponse({ type: UserStatusDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        'The id is not a UUID, or reason is not a string of at most 500 ' +
        'characters.',
    }),
    ApiAdminOnly(),
    ApiStatusForbidden({
      superAdminTarget: {
        summary: 'The target is a super admin, the caller is not',
        value: {
          error: {
            code: 'FORBIDDEN',
            message: 'A super admin is required to suspend a super admin',
          },
        },
      },
    }),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No user has this id.',
    }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description: 'The target is the caller, or is already suspended.',
      content: {
        'application/json': {
          examples: {
            self: {
              summary: 'The target is the caller',
              value: {
                error: {
                  code: 'CONFLICT',
                  message:
                    'You cannot suspend your own account: ask another admin',
                  details: { userId: '22222222-2222-4222-8222-222222222222' },
                },
              },
            },
            alreadySuspended: {
              summary: 'The account is already suspended',
              value: {
                error: {
                  code: 'CONFLICT',
                  message: 'This account is already suspended',
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

export function ApiReinstateUser(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Reinstate a suspended account (admin only)',
      description:
        'Puts a suspended account back to active: from the next request it ' +
        'can sign in and call the API again.\n\n' +
        'Its sessions are not restored with it — the person signs in again ' +
        'rather than walking back in with tokens issued before the ' +
        'suspension — and an open `world` socket stays closed.\n\n' +
        'Who may reinstate whom: a super admin may reinstate anybody; a ' +
        'plain admin only an account that a plain admin suspended, so a ' +
        'suspension a super admin made is lifted only by a super admin. ' +
        'The role recorded at suspension time decides, not the role the ' +
        'suspending admin holds now.\n\n' +
        'Refusals: a 409 for **an account that is not suspended**, which ' +
        'has nothing to be put back. A 403 for a plain admin lifting a ' +
        'suspension a super admin made, for a caller whose own account is ' +
        'no longer active, and for a caller who is not an admin.',
    }),
    ApiOkResponse({ type: UserStatusDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'The id is not a UUID.',
    }),
    ApiAdminOnly(),
    ApiStatusForbidden({
      superAdminSuspension: {
        summary: 'The suspension was made by a super admin',
        value: {
          error: {
            code: 'FORBIDDEN',
            message: 'A super admin is required to lift this suspension',
          },
        },
      },
    }),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No user has this id.',
    }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description: 'The account is not suspended.',
      content: {
        'application/json': {
          examples: {
            notSuspended: {
              summary: 'The account is not suspended',
              value: {
                error: {
                  code: 'CONFLICT',
                  message: 'This account is not suspended',
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
