import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { InviteResponseDto } from '../dto/invite-response.dto.js';

/**
 * The admin-facing create route's OpenAPI description. It lives here rather
 * than on the route because none of it is derivable: Nest can read the path,
 * the body DTO and the success type from the handler, but an error raised
 * three calls deep in InvitesService leaves no trace a decorator scanner can
 * follow. Every response below is therefore written by hand, and kept apart
 * so the controller reads as routing rather than prose.
 */
export function ApiCreateInvite(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Create an invite (admin only)',
      description:
        'Accepts { email, cohortId, cohortRole } for cohort invites — plus ' +
        'guestAccessExpiresAt when that role is guest — or ' +
        '{ email, systemRole: admin } for admin invites. Stores only the ' +
        'SHA-256 hash in ' +
        'INVITES.token_hash and returns a one-time shareable link embedding ' +
        'the raw token. A second pending invite for the same email is ' +
        'rejected with 409 (revoke the open one first). expiresAt defaults ' +
        'to now + INVITE_TTL_DAYS and never exceeds it — nor the guest ' +
        'window, since a link must not stay redeemable past the visit it ' +
        'grants. Then emails the link to the invitee through Resend, when ' +
        'FF_EMAIL_ENABLED is on; emailStatus says how that went. A failed ' +
        'send still answers 201 — the invite exists, and inviteLink can be ' +
        'shared by hand.',
    }),
    ApiCreatedResponse({ type: InviteResponseDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        'A malformed body, or a shape the INVITES CHECK constraints would ' +
        'reject. Mirrored in InvitesService.assertValidShape so the caller ' +
        'sees which pairing rule was broken rather than a constraint name. ' +
        'Note that { email } alone is no longer accepted: every invite but ' +
        'an admin one names a cohort, since an invite naming neither ' +
        'accepts into nothing.',
      content: {
        'application/json': {
          examples: {
            cohortWithoutRole: {
              summary: 'cohortId with no cohortRole',
              value: {
                error: {
                  code: 'INVALID_ARGUMENT',
                  message: 'cohortId and cohortRole must be provided together',
                  details: {
                    cohortId: '11111111-1111-4111-8111-111111111111',
                    cohortRole: null,
                  },
                },
              },
            },
            studentWithoutTrack: {
              summary: 'cohortRole student but no cohortTrackId',
              value: {
                error: {
                  code: 'INVALID_ARGUMENT',
                  message:
                    'cohortTrackId is required when cohortRole is student',
                },
              },
            },
            trackWithoutCohort: {
              summary: 'cohortTrackId with no cohortId',
              value: {
                error: {
                  code: 'INVALID_ARGUMENT',
                  message:
                    'cohortTrackId and mentorshipGroupId require cohortId',
                },
              },
            },
            cohortlessNotAdmin: {
              summary: 'No cohort, and not an admin invite',
              value: {
                error: {
                  code: 'INVALID_ARGUMENT',
                  message:
                    'Only an admin invite may omit a cohort; every other invite names one',
                  details: { systemRole: 'user' },
                },
              },
            },
            guestWithoutEndDate: {
              summary: 'cohortRole guest with no guestAccessExpiresAt',
              value: {
                error: {
                  code: 'INVALID_ARGUMENT',
                  message:
                    'guestAccessExpiresAt is required when cohortRole is guest',
                },
              },
            },
            endDateOnNonGuest: {
              summary: 'guestAccessExpiresAt on a non-guest invite',
              value: {
                error: {
                  code: 'INVALID_ARGUMENT',
                  message: 'guestAccessExpiresAt belongs to guest invites only',
                  details: { cohortRole: 'student' },
                },
              },
            },
            expiresAtInPast: {
              summary: 'expiresAt already in the past',
              value: {
                error: {
                  code: 'INVALID_ARGUMENT',
                  message: 'expiresAt must be in the future',
                },
              },
            },
            trackWrongCohort: {
              summary: 'Track exists, but not in the invite cohort',
              value: {
                error: {
                  code: 'INVALID_ARGUMENT',
                  message: 'cohortTrackId does not belong to cohortId',
                  details: {
                    cohortId: '11111111-1111-4111-8111-111111111111',
                    cohortTrackId: '22222222-2222-4222-8222-222222222222',
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
        'No usable session. Three distinct causes, all refused the same way: ' +
        'the cookie is absent or unparseable, the account behind it no longer ' +
        'exists, or the account is suspended. Suspension is a 401 rather than ' +
        'a 403 because it is decided by SessionGuard, before authorization is ' +
        'reached. A provisional session cannot get here either — the scope ' +
        'check fails first.',
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
            suspended: {
              summary: 'Account suspended — refused before AdminGuard runs',
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
    ApiForbiddenResponse({
      type: ApiErrorResponseDto,
      description:
        'Authenticated but not an admin. Note that a suspended account is NOT ' +
        'a 403 here: SessionGuard rejects it with 401 ACCOUNT_SUSPENDED before ' +
        'AdminGuard ever runs, so 403 means exactly one thing on this route. A ' +
        'provisional session is likewise refused as 401 by the scope check.',
      content: {
        'application/json': {
          examples: {
            notAdmin: {
              summary: 'Ordinary member',
              value: {
                error: {
                  code: 'FORBIDDEN',
                  message: 'Admin role required',
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
        'A pending invite already exists for this address, enforced by the ' +
        'partial unique index invites_email_pending_unique. The open invite ' +
        'must be revoked or allowed to lapse first — it is never reused or ' +
        'rotated, since a link the first recipient still holds would stop ' +
        'working.',
      content: {
        'application/json': {
          examples: {
            pendingDuplicate: {
              summary: 'Address already holds a pending invite',
              value: {
                error: {
                  code: 'CONFLICT',
                  message:
                    'A pending invite already exists for student@campus.local: revoke it before re-inviting',
                  details: {
                    email: 'student@campus.local',
                    inviteId: '66666666-6666-4666-8666-666666666666',
                  },
                },
              },
            },
          },
        },
      },
    }),
    // A bad cohortId / cohortTrackId is a 404 here, not a 400: the body is
    // well-formed, the thing it points at is simply absent. Worth stating so it
    // is not confused with the shape errors above.
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description:
        'A referenced cohort or cohort track does not exist. A track that ' +
        'exists but belongs to a different cohort is a 400 instead — the ' +
        'reference is well-formed, it is just the wrong pairing.',
      content: {
        'application/json': {
          examples: {
            cohortMissing: {
              summary: 'No such cohortId',
              value: {
                error: {
                  code: 'NOT_FOUND',
                  message:
                    'Cohort 11111111-1111-4111-8111-111111111111 not found',
                  details: {
                    cohortId: '11111111-1111-4111-8111-111111111111',
                  },
                },
              },
            },
            trackMissing: {
              summary: 'No such cohortTrackId',
              value: {
                error: {
                  code: 'NOT_FOUND',
                  message:
                    'Cohort track 22222222-2222-4222-8222-222222222222 not found',
                  details: {
                    cohortTrackId: '22222222-2222-4222-8222-222222222222',
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
