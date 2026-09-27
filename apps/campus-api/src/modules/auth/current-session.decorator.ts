import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { AuthenticatedRequest } from '../../shared/auth/authenticated-user.js';
import type { SessionClaims } from './session-token.js';
import type { ProvisionalRequest } from './session.guard.js';

/**
 * Reads req.session set by a SessionGuard, exposing the verified claims
 * (userId, email, scope, inviteId) to the route.
 *
 * Must run behind a guard that guarantees req.session is present.
 */
export const CurrentSession = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SessionClaims => {
    const req = ctx.switchToHttp().getRequest<ProvisionalRequest & AuthenticatedRequest>();
    if (!req.session) {
      throw new Error('CurrentSession used without a session guard');
    }
    return req.session;
  },
);
