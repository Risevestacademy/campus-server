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
import { InviteResponseDto } from '../dto/invite-response.dto.js';

/**
 * OpenAPI description of the admin resend route.
 */
export function ApiResendInvite(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Resend a pending invite with a new link',
      description:
        'Generates a new token for a pending, unexpired invite, saves its ' +
        'hash, and emails the new link. The old link stops working ' +
        'immediately — only the new token hash is stored, so the original ' +
        'link can never be sent again.\n\n' +
        'Only a live pending invite can be resent: status = pending AND ' +
        'expires_at > now. A lapsed pending invite is materialised to ' +
        'expired and answers 403 INVITE_EXPIRED. Settled invites ' +
        '(accepted/declined/revoked/expired) are refused with the same 409 ' +
        'codes the invitee would get for trying to redeem them, so a ' +
        'settled invite has one answer whichever side asks.\n\n' +
        'Returns the same receipt as create (inviteLink, emailStatus), so ' +
        'the admin can still share the link by hand if the email fails ' +
        'again. Each resend uses a new idempotency key derived from the ' +
        'new token hash, so Resend will not silently drop a second email.',
    }),
    ApiOkResponse({ type: InviteResponseDto }),
    ApiAdminOnly(),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No invite with this id.',
    }),
    ApiForbiddenResponse({
      type: ApiErrorResponseDto,
      description:
        'FORBIDDEN: signed in, but not an admin. INVITE_EXPIRED: the invite ' +
        'has expired, so there is nothing to resend.',
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
        'INVITE_REVOKED (this invite has already been answered or revoked).',
    }),
  );
}
