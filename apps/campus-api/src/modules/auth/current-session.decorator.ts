import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { AuthenticatedRequest } from '../../shared/auth/authenticated-user.js';
import type { SessionClaims } from '@campus/session';
import type { ProvisionalRequest, SessionTransport } from './session.guard.js';

/**
 * Reads req.session set by a SessionGuard, exposing the verified claims
 * (userId, email, scope, inviteId) to the route.
 *
 * Must run behind a guard that guarantees req.session is present.
 */
export const CurrentSession = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SessionClaims => {
    const req = ctx
      .switchToHttp()
      .getRequest<ProvisionalRequest & AuthenticatedRequest>();
    if (!req.session) {
      throw new Error('CurrentSession used without a session guard');
    }
    return req.session;
  },
);

/**
 * Whether the session came in the cookie or in an Authorization header. A
 * route that issues a new session answers the same way: a browser gets
 * cookies, and a client that holds its own tokens gets them in the body.
 */
export const CurrentSessionTransport = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SessionTransport => {
    const req = ctx.switchToHttp().getRequest<ProvisionalRequest>();
    if (!req.sessionTransport) {
      throw new Error('CurrentSessionTransport used without a session guard');
    }
    return req.sessionTransport;
  },
);
