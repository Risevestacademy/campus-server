import { applyDecorators } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { InvitePreviewResponseDto } from '../dto/invite-preview.dto.js';

/**
 * OpenAPI description of the public invite preview. See ApiCreateInvite for
 * why these live apart from the routes.
 */
export function ApiPreviewInvite(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Preview an invite from its link, before signing in',
      description:
        'Needs no session: the raw token from the invite link is the proof ' +
        'that the caller was sent it. Returns what the invitation screen ' +
        'shows — cohort, track, role, who sent it and the address it went ' +
        'to — and only while the invite is live, using the same codes as ' +
        'GET /v1/invites/validate-user-invite. A POST so the token travels ' +
        'in the body, which is not logged, rather than the URL, which is. ' +
        'Reads nothing that lets the caller act: accepting still takes a ' +
        'Google sign-in as the invited address.',
    }),
    ApiOkResponse({ type: InvitePreviewResponseDto }),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No invite matches this token — mistyped or truncated.',
    }),
    ApiForbiddenResponse({
      type: ApiErrorResponseDto,
      description: 'FORBIDDEN: the invite has expired.',
    }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description:
        'INVITE_ALREADY_ACCEPTED (send them to sign in), ' +
        'INVITE_ALREADY_DECLINED, or INVITE_REVOKED.',
    }),
  );
}
