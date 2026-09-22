import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import type { AuthenticatedRequest } from '../../../shared/auth/authenticated-user.js';
import {
  InviteForbiddenException,
  InviteUnauthorizedException,
} from '../invites.exceptions.js';

/**
 * Authorization only — authentication belongs to the Google-auth side.
 *
 * Expects the Google-auth layer to have attached req.user
 * ({ id, email, systemRole }) before this guard runs.
 *
 * - No req.user -> InviteUnauthorizedException (401 UNAUTHORIZED).
 * - systemRole != 'admin' -> InviteForbiddenException (403 FORBIDDEN).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!req.user) {
      throw new InviteUnauthorizedException('Authentication required');
    }
    if (req.user.systemRole !== 'admin') {
      throw new InviteForbiddenException('Admin role required');
    }
    return true;
  }
}
