import { Module } from '@nestjs/common';

import { CohortsModule } from '../cohorts/cohorts.module.js';
import { InvitesModule } from '../invites/invites.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { GoogleOAuthService } from './google-oauth.service.js';
import { OAuthStateService } from './oauth-state.service.js';
import { SessionModule } from './session.module.js';

@Module({
  // SessionModule for SessionIssuer, which owns the guards and the minter.
  imports: [UsersModule, InvitesModule, CohortsModule, SessionModule],
  controllers: [AuthController],
  providers: [AuthService, GoogleOAuthService, OAuthStateService],
})
export class AuthModule {}
