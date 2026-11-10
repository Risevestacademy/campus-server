import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { SystemRole } from '../../modules/users/schema.js';
import {
  AccessDeniedException,
  NotAuthenticatedException,
} from '../exceptions/index.js';
import type { AuthenticatedRequest } from './authenticated-user.js';

/**
 * AdminGuard's stricter sibling, for the few routes a plain admin must not
 * reach: super admin or nothing. Runs after SessionGuard, which sets
 * req.user from the row on every request, so a demotion takes effect at once.
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!req.user) {
      throw new NotAuthenticatedException('Authentication required');
    }
    if (req.user.systemRole !== SystemRole.SuperAdmin) {
      throw new AccessDeniedException('Super admin role required');
    }
    return true;
  }
}
