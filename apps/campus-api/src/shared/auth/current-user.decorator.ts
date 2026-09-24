import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type {
  AuthenticatedRequest,
  AuthenticatedUser,
} from './authenticated-user.js';

/**
 * Reads req.user set by the Google-auth layer. Must run behind a guard
 * (e.g. AdminGuard) that guarantees req.user is present.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.user) {
      throw new Error('CurrentUser used without an authentication guard');
    }
    return req.user;
  },
);
