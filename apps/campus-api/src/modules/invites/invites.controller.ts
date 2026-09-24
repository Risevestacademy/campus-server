import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../../shared/dto/api-error-response.dto.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { AdminGuard } from './auth/admin.guard.js';
import { CreateInviteDto } from './dto/create-invite.dto.js';
import { InviteResponseDto } from './dto/invite-response.dto.js';
import { InvitesService } from './invites.service.js';

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
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  @ApiForbiddenResponse({ type: ApiErrorResponseDto })
  @ApiConflictResponse({ type: ApiErrorResponseDto })
  create(
    @Body() dto: CreateInviteDto,
    @CurrentUser() inviter: AuthenticatedUser,
  ): Promise<InviteResponseDto> {
    return this.invites.create(dto, inviter);
  }
}
