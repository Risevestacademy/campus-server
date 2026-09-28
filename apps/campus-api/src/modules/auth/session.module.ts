import { Module } from '@nestjs/common';

import { UsersModule } from '../users/users.module.js';
import { SessionIssuer } from './session-issuer.js';
import { ProvisionalSessionGuard, SessionGuard } from './session.guard.js';

/**
 * Just the guards and the token minter, so feature modules can authenticate —
 * and upgrade a session — without importing the sign-in flow. AuthModule
 * already depends on invites, and importing it back would close a cycle.
 *
 * SessionIssuer lives here rather than in AuthModule for the same reason: it
 * depends on nothing but CONFIG, and invite acceptance needs to mint an
 * upgraded token without pulling in the OAuth controller that sits beside it.
 */
@Module({
  imports: [UsersModule],
  providers: [SessionGuard, ProvisionalSessionGuard, SessionIssuer],
  // UsersModule travels with the guards: @UseGuards builds them inside the
  // module that declares the controller, so that module has to be able to
  // resolve what they inject.
  exports: [SessionGuard, ProvisionalSessionGuard, SessionIssuer, UsersModule],
})
export class SessionModule {}
