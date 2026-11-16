import type { ExecutionContext } from '@nestjs/common';

import { SystemRole } from '../../modules/users/schema.js';
import {
  AccessDeniedException,
  NotAuthenticatedException,
} from '../exceptions/index.js';
import type { AuthenticatedRequest } from './authenticated-user.js';
import { SuperAdminGuard } from './super-admin.guard.js';

function contextWithUser(user: AuthenticatedRequest['user']): ExecutionContext {
  const req = { user } as AuthenticatedRequest;
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const as = (systemRole: SystemRole) =>
  contextWithUser({ id: 'u1', email: 'someone@campus.local', systemRole });

describe('SuperAdminGuard', () => {
  const guard = new SuperAdminGuard();

  it('rejects a caller with no req.user (401)', () => {
    expect(() => guard.canActivate(contextWithUser(undefined))).toThrow(
      NotAuthenticatedException,
    );
  });

  it('rejects an ordinary user and a plain admin (403)', () => {
    expect(() => guard.canActivate(as(SystemRole.User))).toThrow(
      AccessDeniedException,
    );
    expect(() => guard.canActivate(as(SystemRole.Admin))).toThrow(
      AccessDeniedException,
    );
  });

  it('allows a super admin', () => {
    expect(guard.canActivate(as(SystemRole.SuperAdmin))).toBe(true);
  });
});
