import { applyDecorators } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';

import { ApiAdminOnly } from '../../../shared/dto/admin-route.docs.js';
import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { RevokeInviteResponseDto } from '../dto/invite-admin-list.dto.js';

/**
 * OpenAPI description of the admin revoke route. See ApiCreateInvite for why
 * these live apart from the routes.
 */
export function ApiRevokeInvite(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Revoke a pending invite',
      description:
        'Cancels an offer you no longer want to honour, recording which ' +
        'admin did it and when. This is the step POST /v1/invites asks for ' +
        'before re-inviting an address: only one pending invite per address ' +
        'is allowed, and revoking is what frees the slot.\n\n' +
        'Only a live pending invite can be revoked. One already accepted, ' +
        'declined or revoked answers with the same 409 code the invitee would ' +
        'get for trying to redeem it, so a settled invite has one answer ' +
        'whichever side asks. Revoking twice is a 409 rather than a silent ' +
        'success.\n\n' +
        'An invite that has lapsed cannot be revoked — it has already stopped ' +
        'on its own, so there is no cancellation to record. It answers 403 ' +
        'INVITE_EXPIRED, and its status is materialised as expired.\n\n' +
        'Afterwards the invitee can no longer sign in with it. Somebody part ' +
        'way through onboarding gets INVITE_REVOKED (409) on their next ' +
        'call — unless they have been invited again, in which case ' +
        'validate-user-invite shows them the new invite and a decision ' +
        'naming it is accepted.',
    }),
    ApiOkResponse({ type: RevokeInviteResponseDto }),
    ApiAdminOnly(),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No invite with this id.',
    }),
    // Replaces the 403 ApiAdminOnly documents — one status, one entry — so
    // both of its causes are listed here, told apart by code.
    ApiForbiddenResponse({
      type: ApiErrorResponseDto,
      description:
        'FORBIDDEN: signed in, but not an admin. INVITE_EXPIRED: the invite ' +
        'has expired, so there is nothing to revoke.',
      content: {
        'application/json': {
          examples: {
            notAdmin: {
              summary: 'Ordinary member',
              value: {
                error: { code: 'FORBIDDEN', message: 'Admin role required' },
              },
            },
            expired: {
              summary: 'The invite lapsed first',
              value: {
                error: {
                  code: 'INVITE_EXPIRED',
                  message: 'This invite has expired',
                  details: {
                    inviteId: '44444444-4444-4444-8444-444444444444',
                    expiresAt: '2026-09-01T00:00:00.000Z',
                  },
                },
              },
            },
          },
        },
      },
    }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description:
        'INVITE_ALREADY_ACCEPTED, INVITE_ALREADY_DECLINED, or ' +
        'INVITE_REVOKED (this invite is already revoked).',
    }),
  );
}
