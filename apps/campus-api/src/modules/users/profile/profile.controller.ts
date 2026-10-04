import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedUser } from '../../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../../shared/auth/current-user.decorator.js';
import { SessionGuard } from '../../auth/session.guard.js';
import {
  ApiGetOwnProfile,
  ApiGetProfileCard,
  ApiUpdateOwnProfile,
} from './docs/profile.docs.js';
import {
  OwnProfileDto,
  ProfileCardDto,
  UpdateProfileDto,
  UserIdParamDto,
} from './dto/profile.dto.js';
import { ProfileService } from './profile.service.js';

/**
 * A member's own profile, and the card they see of other members. Under
 * `users` beside the admin list, but its own controller: these are for any
 * full-access session, where the list is for admins.
 */
@ApiTags('profile')
@ApiBearerAuth()
// Full access only. Somebody mid-onboarding is shown their details by the
// invite routes, and has no profile to edit until they have accepted.
@UseGuards(SessionGuard)
@Controller('users')
export class ProfileController {
  constructor(private readonly profiles: ProfileService) {}

  @Get('me')
  @ApiGetOwnProfile()
  getOwn(@CurrentUser() user: AuthenticatedUser): Promise<OwnProfileDto> {
    return this.profiles.getOwn(user.id);
  }

  @Patch('me')
  @ApiUpdateOwnProfile()
  updateOwn(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ): Promise<OwnProfileDto> {
    return this.profiles.updateOwn(user.id, dto);
  }

  @Get(':id/profile')
  @ApiGetProfileCard()
  getCard(
    @CurrentUser() viewer: AuthenticatedUser,
    @Param() params: UserIdParamDto,
  ): Promise<ProfileCardDto> {
    return this.profiles.getCard(viewer, params.id);
  }
}
