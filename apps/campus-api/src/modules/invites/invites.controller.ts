import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
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
import type { Response } from 'express';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import { ApiErrorResponseDto } from '../../shared/dto/api-error-response.dto.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import { CurrentSession } from '../auth/current-session.decorator.js';
import { requireGoogleAuth } from '../auth/google-auth.settings.js';
import {
  SESSION_COOKIE,
  sessionCookieOptions,
} from '../auth/session-cookie.js';
import { SessionIssuer } from '../auth/session-issuer.js';
import { ProvisionalSessionGuard, SessionGuard } from '../auth/session.guard.js';
import { AdminGuard } from './auth/admin.guard.js';
import { CreateInviteDto } from './dto/create-invite.dto.js';
import {
  InviteDecisionDto,
  InviteDecisionResponseDto,
} from './dto/invite-decision.dto.js';
import { InviteOnboardingResponseDto } from './dto/invite-onboarding-response.dto.js';
import { InviteResponseDto } from './dto/invite-response.dto.js';
import { InvitesService } from './invites.service.js';
import { InviteNotFoundException } from './invites.exceptions.js';

@ApiTags('invites')
@ApiBearerAuth()
@Controller('invites')
export class InvitesController {
  constructor(
    private readonly invites: InvitesService,
    private readonly sessions: SessionIssuer,
    @Inject(CONFIG) private readonly config: Env,
  ) {}

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

  @Post('decision')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProvisionalSessionGuard)
  @ApiOperation({
    summary: 'Accept or decline the invite this session was opened with',
    description:
      'Answers the invite named in the session cookie — the caller does not ' +
      'say which one. Accept enrols the invitee (or revives a membership they ' +
      'previously left), applies the invite\'s systemRole, and replaces the ' +
      'provisional cookie with a full-access one. Decline closes the invite ' +
      'and clears the cookie, leaving the account row in place. An invite ' +
      'that already carries an answer is a 409 — branch on error.code to ' +
      'decide where the caller goes next.',
  })
  @ApiOkResponse({ type: InviteDecisionResponseDto })
  @ApiBadRequestResponse({
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
                  fields: { decision: 'decision must be one of: accept, decline' },
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
              error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
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
  })
  @ApiNotFoundResponse({
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
  })
  @ApiForbiddenResponse({
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
  })
  @ApiConflictResponse({
    type: ApiErrorResponseDto,
    description:
      'The invite already carries an answer, so there is nothing to decide. ' +
      'Branch on error.code, not on the 409: INVITE_ALREADY_ACCEPTED means ' +
      'the offer was taken, so send the caller back through sign-in to pick ' +
      'up the membership. INVITE_ALREADY_DECLINED and INVITE_REVOKED both ' +
      'mean the offer is closed — leave the flow. details.status repeats the ' +
      'same fact for logging. Re-sending the same decision is never the ' +
      'recovery: a lost response is indistinguishable from a deliberate ' +
      'second answer, and treating them alike would let a retry reopen an ' +
      'invite that was already settled. The validation route reports the same ' +
      'codes for the same states.',
    content: {
      'application/json': {
        examples: {
          alreadyAccepted: {
            summary: 'INVITE_ALREADY_ACCEPTED — send them back through sign-in',
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
          revoked: {
            summary: 'INVITE_REVOKED — withdrawn by an admin, same handling as declined',
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
  })
  async decide(
    @CurrentSession() session: { inviteId?: string },
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InviteDecisionDto,
    // passthrough keeps Nest serialising `response` below; a bare @Res would
    // hand body-writing to this method instead.
    @Res({ passthrough: true }) res: Response,
  ): Promise<InviteDecisionResponseDto> {
    if (!session.inviteId) {
      throw new InviteNotFoundException('This session has no invite', {
        userId: user.id,
      });
    }

    const outcome = await this.invites.decide(
      session.inviteId,
      dto.decision,
      user,
    );

    const cookieBase = {
      apiUrl: requireGoogleAuth(this.config).callbackUrl,
      appUrl: this.config.APP_PUBLIC_URL,
    };

    if (outcome.kind === 'accepted') {
      const upgraded = await this.sessions.issueFullAccess(outcome.account);
      res.cookie(
        SESSION_COOKIE,
        upgraded.token,
        sessionCookieOptions(
          cookieBase.apiUrl,
          cookieBase.appUrl,
          upgraded.expiresAt,
        ),
      );
    } else {
      // A provisional session with nothing left to finish is a dead end, so
      // declining takes the cookie with it. The options are the same ones the
      // cookie was set with — a mismatched path or SameSite would leave it in
      // place.
      res.clearCookie(
        SESSION_COOKIE,
        sessionCookieOptions(cookieBase.apiUrl, cookieBase.appUrl, new Date(0)),
      );
    }

    return outcome.response;
  }
}
