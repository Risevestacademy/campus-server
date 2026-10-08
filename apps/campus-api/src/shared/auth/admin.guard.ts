import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { hasAdminPowers } from '../../modules/users/schema.js';
import {
  AccessDeniedException,
  NotAuthenticatedException,
} from '../exceptions/index.js';
import type { AuthenticatedRequest } from './authenticated-user.js';

/**
 * Authorization only — authentication belongs to the Google-auth side.
 *
 * Expects the Google-auth layer to have attached req.user
 * ({ id, email, systemRole }) before this guard runs.
 *
 * - No req.user -> NotAuthenticatedException (401 UNAUTHORIZED).
 * - systemRole is neither admin role -> AccessDeniedException (403 FORBIDDEN).
 *
 * Lives in shared rather than beside the one route that uses it today: the
 * check is about system_role and nothing else, so an invite-flavoured
 * exception was the only thing that ever made it belong to invites.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!req.user) {
      throw new NotAuthenticatedException('Authentication required');
    }
    if (!hasAdminPowers(req.user.systemRole)) {
      throw new AccessDeniedException('Admin role required');
    }
    return true;
  }
}
