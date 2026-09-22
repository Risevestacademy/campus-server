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
import { AdminGuard } from './auth/admin.guard.js';
import { CreateInviteDto } from './dto/create-invite.dto.js';
import { InviteResponseDto } from './dto/invite-response.dto.js';
import { InvitesService } from './invites.service.js';

@ApiTags('invites')
@ApiBearerAuth()
// Authenticated by the Google-auth layer (req.user); this guard only checks admin role.
@Controller('invites')
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary: 'Create an invite (admin only)',
    description:
      'Accepts { email, cohortId, cohortRole } for cohort invites or ' +
      '{ email, systemRole: admin } for admin invites. Stores only the ' +
      'SHA-256 hash in INVITES.token_hash and returns a one-time shareable ' +
      'link embedding the raw token. A second pending invite for the same ' +
      'email is rejected with 409 (revoke the open one first).',
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
