import type { ExecutionContext } from '@nestjs/common';

import { SystemRole } from '../../modules/users/schema.js';
import {
  AccessDeniedException,
  NotAuthenticatedException,
} from '../exceptions/index.js';
import { AdminGuard } from './admin.guard.js';
import type { AuthenticatedRequest } from './authenticated-user.js';

function contextWithUser(user: AuthenticatedRequest['user']): ExecutionContext {
  const req = { user } as AuthenticatedRequest;
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('AdminGuard', () => {
  const guard = new AdminGuard();

  it('rejects unauthenticated callers with no req.user (401)', () => {
    expect(() => guard.canActivate(contextWithUser(undefined))).toThrow(
      NotAuthenticatedException,
    );
  });

  it('rejects callers where system_role != admin (403)', () => {
    const ctx = contextWithUser({
      id: 'u1',
      email: 'user@campus.local',
      systemRole: SystemRole.User,
    });
    expect(() => guard.canActivate(ctx)).toThrow(AccessDeniedException);
  });

  it('allows admins carrying req.user from the Google-auth layer', () => {
    const ctx = contextWithUser({
      id: 'a1',
      email: 'admin@campus.local',
      systemRole: SystemRole.Admin,
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
