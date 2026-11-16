import { applyDecorators } from '@nestjs/common';
import {
  ApiConflictResponse,
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
      summary: 'Resend an invite with a new link',
      description:
        'For an invite whose email never arrived, or whose link ran out ' +
        'before anybody used it. Generates a new token, emails the new ' +
        'link, and returns the same receipt as POST /v1/invites, so the ' +
        'link can still be shared by hand if the email fails again.\n\n' +
        'The old link stops working at once. Only the hash of a token is ' +
        'stored, so the original link cannot be sent a second time.\n\n' +
        'Works on a pending or an expired invite, and leaves it pending ' +
        'for as long again as it was created to last: the default window, ' +
        'or the shorter one its `expiresAt` set. For a guest, never past ' +
        'the end of the visit.\n\n' +
        'Resending an expired invite offers it again, so it is checked as ' +
        'a new invite would be and answers 409 CONFLICT when the address ' +
        'already holds another pending invite, the person has joined the ' +
        'cohort since, or the guest visit it offered is over.\n\n' +
        'An accepted, declined or revoked invite is refused with the 409 ' +
        'code every other route gives it.\n\n' +
        'Each resend is recorded in the audit log with the admin who did it.',
    }),
    ApiOkResponse({ type: InviteResponseDto }),
    ApiAdminOnly(),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No invite with this id.',
    }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description:
        'INVITE_ALREADY_ACCEPTED, INVITE_ALREADY_DECLINED or INVITE_REVOKED: ' +
        'the invite has been answered or cancelled. CONFLICT: an expired ' +
        'invite that can no longer be offered again — see the message.',
      content: {
        'application/json': {
          examples: {
            anotherPending: {
              summary: 'The address has been invited again since',
              value: {
                error: {
                  code: 'CONFLICT',
                  message:
                    'A pending invite already exists for ' +
                    'new.student@campus.local: revoke it before re-inviting',
                  details: {
                    email: 'new.student@campus.local',
                    inviteId: '44444444-4444-4444-8444-444444444444',
                  },
                },
              },
            },
          },
        },
      },
    }),
  );
}
