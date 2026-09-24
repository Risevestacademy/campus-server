import { Module } from '@nestjs/common';

import { UsersModule } from '../users/users.module.js';
import { ProvisionalSessionGuard, SessionGuard } from './session.guard.js';

/**
 * Just the guards, so feature modules can authenticate without importing the
 * sign-in flow — AuthModule already depends on invites, and importing it back
 * would close a cycle.
 */
@Module({
  imports: [UsersModule],
  providers: [SessionGuard, ProvisionalSessionGuard],
  // UsersModule travels with the guards: @UseGuards builds them inside the
  // module that declares the controller, so that module has to be able to
  // resolve what they inject.
  exports: [SessionGuard, ProvisionalSessionGuard, UsersModule],
})
export class SessionModule {}
