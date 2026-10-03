import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { InviteFlagResponseDto } from '../dto/invite-flag.dto.js';

/**
 * OpenAPI description of the flag route. See ApiCreateInvite for why these
 * live apart from the routes.
 */
export function ApiFlagInvite(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Flag a mistake on the invite the signed-in account has',
      description:
        'For the invitee who can see the offer is wrong — the role, the ' +
        'track, the cohort — to say so before answering. The message is ' +
        'recorded on the invite and emailed to the admin who sent it; every ' +
        'admin can find it with GET /v1/invites?flagged=true.\n\n' +
        'A flag is a note, not an answer. The invite stays pending and ' +
        'POST /v1/invites/decision works exactly as before, so the invitee ' +
        'can flag and still accept. Correcting the offer is the admin’s ' +
        'move: revoke it and send another.\n\n' +
        'Which invite is flagged follows the rule the decision route uses: ' +
        'a provisional session flags its own unless `inviteId` names the ' +
        'live replacement, and a full-access session must name it.\n\n' +
        'One flag per invite. A second is a 409 CONFLICT, and ' +
        'validate-user-invite reports `flaggedAt` so the screen can show ' +
        'that it has already been sent. No cookie is set or cleared.',
    }),
    ApiOkResponse({ type: InviteFlagResponseDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        'The message is missing, blank or too long, or a full-access ' +
        'session did not name the invite in `inviteId`.',
      content: {
        'application/json': {
          examples: {
            blankMessage: {
              summary: 'Nothing to tell the admin',
              value: {
                error: {
                  code: 'INVALID_ARGUMENT',
                  message: 'Request validation failed',
                  details: {
                    fields: { message: 'message should not be empty' },
                  },
                },
              },
            },
          },
        },
      },
    }),
    ApiUnauthorizedResponse({
      type: ApiErrorResponseDto,
      description: 'No usable session.',
    }),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No invite matches this session, or the one named.',
    }),
    ApiForbiddenResponse({
      type: ApiErrorResponseDto,
      description: 'INVITE_EXPIRED: the invite has expired.',
    }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description:
        'CONFLICT: this invite is already flagged. ' +
        'INVITE_ALREADY_ACCEPTED, INVITE_ALREADY_DECLINED or INVITE_REVOKED: ' +
        'the invite is settled, with the same code every other route gives it.',
      content: {
        'application/json': {
          examples: {
            alreadyFlagged: {
              summary: 'Flagged before',
              value: {
                error: {
                  code: 'CONFLICT',
                  message: 'This invite is already flagged',
                  details: {
                    inviteId: '66666666-6666-4666-8666-666666666666',
                    flaggedAt: '2026-10-03T12:00:00.000Z',
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
