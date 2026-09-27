import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../../shared/dto/api-error-response.dto.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import { CurrentSession } from '../auth/current-session.decorator.js';
import { ProvisionalSessionGuard, SessionGuard } from '../auth/session.guard.js';
import { AdminGuard } from './auth/admin.guard.js';
import { CreateInviteDto } from './dto/create-invite.dto.js';
import { InviteOnboardingResponseDto } from './dto/invite-onboarding-response.dto.js';
import { InviteResponseDto } from './dto/invite-response.dto.js';
import { InvitesService } from './invites.service.js';
import { InviteNotFoundException } from './invites.exceptions.js';

@ApiTags('invites')
@ApiBearerAuth()
@Controller('invites')
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  // SessionGuard authenticates and puts req.user there; AdminGuard decides
  // whether that user may invite. Order matters — guards run left to right.
  @UseGuards(SessionGuard, AdminGuard)
  @ApiOperation({
    summary: 'Create an invite (admin only)',
    description:
      'Accepts { email, cohortId, cohortRole } for cohort invites, ' +
      '{ email, systemRole: admin } for admin invites, or { email } alone ' +
      'for a guest invite. Stores only the SHA-256 hash in ' +
      'INVITES.token_hash and returns a one-time shareable link embedding ' +
      'the raw token. A second pending invite for the same email is ' +
      'rejected with 409 (revoke the open one first). expiresAt defaults ' +
      'to now + INVITE_TTL_DAYS and never exceeds it.',
  })
  @ApiCreatedResponse({ type: InviteResponseDto })
  @ApiBadRequestResponse({
    type: ApiErrorResponseDto,
    description:
      'A malformed body, or a shape the INVITES CHECK constraints would ' +
      'reject. Mirrored in InvitesService.assertValidShape so the caller ' +
      'sees which pairing rule was broken rather than a constraint name.',
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
                message: 'cohortTrackId is required when cohortRole is student',
              },
            },
          },
          trackWithoutCohort: {
            summary: 'cohortTrackId with no cohortId',
            value: {
              error: {
                code: 'INVALID_ARGUMENT',
                message: 'cohortTrackId and mentorshipGroupId require cohortId',
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
  })
  @ApiUnauthorizedResponse({
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
  })
  @ApiForbiddenResponse({
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
  })
  @ApiConflictResponse({
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
  })
  // A bad cohortId / cohortTrackId is a 404 here, not a 400: the body is
  // well-formed, the thing it points at is simply absent. Worth stating so it
  // is not confused with the shape errors above.
  @ApiNotFoundResponse({
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
                message: 'Cohort 11111111-1111-4111-8111-111111111111 not found',
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
  })
  create(
    @Body() dto: CreateInviteDto,
    @CurrentUser() inviter: AuthenticatedUser,
  ): Promise<InviteResponseDto> {
    return this.invites.create(dto, inviter);
  }

  // ProvisionalSessionGuard, not SessionGuard: the caller is mid-onboarding
  // and must not be able to reach the full-access half of the API by
  // holding a token that has not accepted an invite yet.
  @Get('validate-user-invite')
  @UseGuards(ProvisionalSessionGuard)
  @ApiOperation({
    summary: 'Validate the invite the current provisional session was issued for',
    description:
      'Resolves the invite from the inviteId carried in the provisional ' +
      'session, confirms it is addressed to the signed-in account, and ' +
      'returns it only while it is still live. Takes no body: the session ' +
      'identifies both the invite and the caller, so a full-access session ' +
      'is rejected with 401 rather than quietly reading someone else\'s ' +
      'offer. Returns 200 only for a live invite, so the decision screen can ' +
      'be rendered as-is. Not a re-send of the admin create-receipt: the ' +
      'token, the shareable link, the invited address and mentorshipGroupId ' +
      '(no MENTORSHIP_GROUPS table) are all withheld. Note this read is not ' +
      'free of writes — a lapsed-but-still-pending invite has its status ' +
      'materialised here, which is what makes the following 403 truthful.',
  })
  @ApiOkResponse({ type: InviteOnboardingResponseDto })
  @ApiUnauthorizedResponse({
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
  })
  @ApiNotFoundResponse({
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
  })
  @ApiForbiddenResponse({
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
  })
  @ApiConflictResponse({
    type: ApiErrorResponseDto,
    description:
      'The invite reached a terminal state — accepted, declined or revoked — ' +
      'so there is no decision left to make. Distinct from the 403 above: ' +
      'that one was live and ran out of time, this one was resolved by ' +
      'somebody. Retrying cannot change the answer.',
    content: {
      'application/json': {
        examples: {
          accepted: {
            summary: 'Already accepted',
            value: {
              error: {
                code: 'CONFLICT',
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
                code: 'CONFLICT',
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
  })
  async validateUserInvite(
    @CurrentSession() session: { inviteId?: string },
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InviteOnboardingResponseDto> {
    // issueProvisional always sets inviteId, but SessionClaims types it
    // optional for scopes that have no invite, so it is checked rather than
    // asserted.
    if (!session.inviteId) {
      throw new InviteNotFoundException('This session has no invite', {
        userId: user.id,
      });
    }
    return this.invites.getOnboardingInvite(session.inviteId, user);
  }
}
