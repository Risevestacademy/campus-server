import type { ExecutionContext } from '@nestjs/common';

import type { AuthenticatedRequest } from '../../shared/auth/authenticated-user.js';
import {
  InviteForbiddenException,
  InviteUnauthorizedException,
} from '../invites.exceptions.js';
import { AdminGuard } from './admin.guard.js';

function contextWithUser(user: AuthenticatedRequest['user']): ExecutionContext {
  const req = { user } as AuthenticatedRequest;
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('AdminGuard', () => {
  const guard = new AdminGuard();

  it('rejects unauthenticated callers with no req.user (401)', () => {
    expect(() =>
      guard.canActivate(contextWithUser(undefined)),
    ).toThrow(InviteUnauthorizedException);
  });

  it('rejects callers where system_role != admin (403)', () => {
    const ctx = contextWithUser({
      id: 'u1',
      email: 'user@campus.local',
      systemRole: 'user',
    });
    expect(() => guard.canActivate(ctx)).toThrow(InviteForbiddenException);
  });

  it('allows admins carrying req.user from the Google-auth layer', () => {
    const ctx = contextWithUser({
      id: 'a1',
      email: 'admin@campus.local',
      systemRole: 'admin',
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
