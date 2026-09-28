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
import { InviteDecisionResponseDto } from '../dto/invite-decision.dto.js';

/**
 * OpenAPI description of the accept/decline route. See ApiCreateInvite for
 * why these live apart from the routes.
 */
export function ApiDecideInvite(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Accept or decline the invite this session was opened with',
      description:
        'Answers the invite named in the session cookie — the caller does not ' +
        'say which one. Accept enrols the invitee (or revives a membership they ' +
        "previously left), applies the invite's systemRole, and replaces the " +
        'provisional cookie with a full-access one. Decline closes the invite ' +
        'and clears the cookie, leaving the account row in place. An invite ' +
        'that already carries an answer is a 409 — branch on error.code to ' +
        'decide where the caller goes next.',
    }),
    ApiOkResponse({ type: InviteDecisionResponseDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        'The body is not one of the two decisions. An absent or empty body ' +
        'reports the same way, since `decision` is the only field.',
      content: {
        'application/json': {
          examples: {
            unknownDecision: {
              summary: 'decision is neither accept nor decline',
              value: {
                error: {
                  code: 'INVALID_ARGUMENT',
                  message: 'Request validation failed',
                  details: {
                    fields: {
                      decision: 'decision must be one of: accept, decline',
                    },
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
      description:
        'The session cannot answer a decision. A full-access session is ' +
        'refused here: someone already on the roster has nothing left to ' +
        'decide. A suspended account is a 401 rather than a 403 because the ' +
        'guard rejects it before the route runs.',
      content: {
        'application/json': {
          examples: {
            noSession: {
              summary: 'Cookie absent or unparseable',
              value: {
                error: {
                  code: 'UNAUTHORIZED',
                  message: 'Authentication required',
                },
              },
            },
            alreadyOnRoster: {
              summary: 'Full-access session',
              value: {
                error: {
                  code: 'UNAUTHORIZED',
                  message: 'Session is of the wrong kind',
                },
              },
            },
            suspended: {
              summary: 'Account suspended',
              value: {
                error: {
                  code: 'UNAUTHORIZED',
                  message: 'Account is suspended',
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
        'The session names no invite, or names one that does not exist. Both ' +
        'mean there is nothing here to decide.',
      content: {
        'application/json': {
          examples: {
            noInviteClaim: {
              summary: 'Session carries no inviteId',
              value: {
                error: {
                  code: 'NOT_FOUND',
                  message: 'This session has no invite',
                  details: { userId: '77777777-7777-4777-8777-777777777777' },
                },
              },
            },
            unknownInvite: {
              summary: 'No such invite',
              value: {
                error: {
                  code: 'NOT_FOUND',
                  message: 'No invite matches this session',
                  details: {
                    inviteId: '00000000-0000-4000-8000-000000000000',
                  },
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
        'The invite lapsed before it was answered. Applies to decline as well ' +
        'as accept: an expired offer cannot be turned down either. The same 403 ' +
        'comes back whether or not the expiry has already been materialised by ' +
        'a read, so the code does not depend on what the caller did earlier.',
      content: {
        'application/json': {
          examples: {
            lapsed: {
              summary: 'Past expires_at, still pending',
              value: {
                error: {
                  code: 'FORBIDDEN',
                  message: 'This invite has expired',
                  details: {
                    inviteId: '66666666-6666-4666-8666-666666666666',
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
        'The invite already carries an answer, so there is nothing to decide. ' +
        'Branch on error.code, not on the 409: INVITE_ALREADY_ACCEPTED means ' +
        'the offer was taken, so send the caller back through sign-in to pick ' +
        'up the membership. INVITE_ALREADY_DECLINED and INVITE_REVOKED both ' +
        'mean the offer is closed — leave the flow. A plain CONFLICT is a ' +
        'different thing: the invite is still live, but the account already ' +
        'holds a standing membership of that cohort which an invite must ' +
        'not overwrite, so it stays pending for an admin to resolve. ' +
        'details.status repeats the ' +
        'same fact for logging. Re-sending the same decision is never the ' +
        'recovery: a lost response is indistinguishable from a deliberate ' +
        'second answer, and treating them alike would let a retry reopen an ' +
        'invite that was already settled. The validation route reports the same ' +
        'codes for the same states.',
      content: {
        'application/json': {
          examples: {
            alreadyAccepted: {
              summary:
                'INVITE_ALREADY_ACCEPTED — send them back through sign-in',
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
            alreadyDeclined: {
              summary: 'INVITE_ALREADY_DECLINED — leave the flow',
              value: {
                error: {
                  code: 'INVITE_ALREADY_DECLINED',
                  message: 'This invite is already declined',
                  details: {
                    inviteId: '66666666-6666-4666-8666-666666666666',
                    status: 'declined',
                  },
                },
              },
            },
            alreadyAMember: {
              summary: 'CONFLICT — live membership the invite must not rewrite',
              value: {
                error: {
                  code: 'CONFLICT',
                  message: 'This account is already a member of that cohort',
                  details: {
                    inviteId: '66666666-6666-4666-8666-666666666666',
                    cohortId: '11111111-1111-4111-8111-111111111111',
                    userId: '55555555-5555-4555-8555-555555555555',
                  },
                },
              },
            },
            revoked: {
              summary:
                'INVITE_REVOKED — withdrawn by an admin, same handling as declined',
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
