import { applyDecorators } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { InviteOnboardingResponseDto } from '../dto/invite-onboarding-response.dto.js';

/**
 * OpenAPI description of the onboarding read. See ApiCreateInvite for why
 * these live apart from the routes.
 */
export function ApiValidateUserInvite(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary:
        'Validate the invite the current provisional session was issued for',
      description:
        'Resolves the invite from the inviteId carried in the provisional ' +
        'session, confirms it is addressed to the signed-in account, and ' +
        'returns it only while it is still live. Takes no body: the session ' +
        'identifies both the invite and the caller, so a full-access session ' +
        "is rejected with 401 rather than quietly reading someone else's " +
        'offer. Returns 200 only for a live invite, so the decision screen can ' +
        'be rendered as-is. Not a re-send of the admin create-receipt: the ' +
        'token, the shareable link and mentorshipGroupId (no MENTORSHIP_GROUPS ' +
        'table) are withheld. The address under `invitee` is the signed-in ' +
        "account's own, read from its USERS row — the same string as the " +
        'invited address, because the two must match to get this far. Note ' +
        'this read is not ' +
        'free of writes — a lapsed-but-still-pending invite has its status ' +
        'materialised here, which is what makes the following 403 truthful.',
    }),
    ApiOkResponse({ type: InviteOnboardingResponseDto }),
    ApiUnauthorizedResponse({
      type: ApiErrorResponseDto,
      description:
        'No session, or a session that is not provisional. A full-access ' +
        'session lands here too: this endpoint only finishes onboarding, so ' +
        'there is no invite for an already-onboarded caller to read.',
      content: {
        'application/json': {
          examples: {
            noSession: {
              summary: 'Cookie absent or unparseable',
              value: {
                error: {
                  code: 'UNAUTHORIZED',
                  message: 'Session is not usable',
                },
              },
            },
            wrongScope: {
              summary: 'Valid session, but full_access rather than provisional',
              value: {
                error: {
                  code: 'UNAUTHORIZED',
                  message: 'Session is of the wrong kind',
                },
              },
            },
          },
        },
      },
    }),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description:
        'The session carries an inviteId but no such invite exists, or the ' +
        'provisional session has no inviteId at all. The first means a stale ' +
        'or tampered cookie; the second is answered identically rather than ' +
        'distinguished, so a probe cannot tell the two apart.',
      content: {
        'application/json': {
          examples: {
            unknownInvite: {
              summary: 'inviteId on the session matches no row',
              value: {
                error: {
                  code: 'NOT_FOUND',
                  message: 'No invite matches this session',
                  details: { inviteId: '66666666-6666-4666-8666-666666666666' },
                },
              },
            },
            sessionHasNoInvite: {
              summary: 'Provisional session with no inviteId claim',
              value: {
                error: {
                  code: 'NOT_FOUND',
                  message: 'This session has no invite',
                  details: { userId: '55555555-5555-4555-8555-555555555555' },
                },
              },
            },
          },
        },
      },
    }),
    ApiForbiddenResponse({
      type: ApiErrorResponseDto,
      description:
        'The invite was still pending but its expiresAt has passed. The status ' +
        'is materialised to expired before this is thrown, so the same request ' +
        'replayed a moment later answers 409 rather than 403 — a lapsed invite ' +
        'is a state that resolves, and the row is left consistent with it.',
      content: {
        'application/json': {
          examples: {
            lapsed: {
              summary: 'Pending, but expiresAt already in the past',
              value: {
                error: {
                  code: 'FORBIDDEN',
                  message: 'This invite has expired',
                  details: {
                    inviteId: '66666666-6666-4666-8666-666666666666',
                    expiresAt: new Date('2026-09-15T12:00:00.000Z'),
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
        'The invite reached a terminal state — accepted, declined or revoked — ' +
        'so there is no decision left to make. Distinct from the 403 above: ' +
        'that one was live and ran out of time, this one was resolved by ' +
        'somebody. Retrying cannot change the answer. error.code names which ' +
        'answer stands (INVITE_ALREADY_ACCEPTED, INVITE_ALREADY_DECLINED, ' +
        'INVITE_REVOKED) and is the same on the decision route, so a caller ' +
        'that validates before deciding sees one vocabulary.',
      content: {
        'application/json': {
          examples: {
            accepted: {
              summary: 'Already accepted',
              value: {
                error: {
                  code: 'INVITE_ALREADY_ACCEPTED',
                  message: 'This invite is already accepted',
                  details: {
                    inviteId: '66666666-6666-4666-8666-666666666666',
                    status: 'accepted',
                  },
                },
              },
            },
            revoked: {
              summary: 'Revoked by an admin',
              value: {
                error: {
                  code: 'INVITE_REVOKED',
                  message: 'This invite is already revoked',
                  details: {
                    inviteId: '66666666-6666-4666-8666-666666666666',
                    status: 'revoked',
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
