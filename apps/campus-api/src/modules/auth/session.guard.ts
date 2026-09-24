import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import type { AuthenticatedRequest } from '../../shared/auth/authenticated-user.js';
import { UsersService } from '../users/users.service.js';
import { requireGoogleAuth } from './google-auth.settings.js';
import { SessionUnauthorizedError } from './auth.exceptions.js';
import { readSessionCookie } from './session-cookie.js';
import {
  InvalidSessionTokenError,
  SessionScope,
  verifySessionToken,
  type SessionClaims,
} from './session-token.js';

/** The provisional half of a session, for routes that finish onboarding. */
export type ProvisionalRequest = AuthenticatedRequest & {
  session?: SessionClaims;
};

function bearer(header: string | undefined): string | undefined {
  if (!header?.startsWith('Bearer ')) {
    return undefined;
  }
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : undefined;
}

@Injectable()
abstract class SessionGuardBase implements CanActivate {
  constructor(
    @Inject(CONFIG) protected readonly config: Env,
    protected readonly users: UsersService,
  ) {}

  protected abstract readonly scope: SessionScope;

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ProvisionalRequest>();

    // The cookie is how a browser carries it; the header is for API clients
    // and for anyone poking at this with curl.
    const token =
      readSessionCookie(req.headers.cookie) ?? bearer(req.headers.authorization);
    if (!token) {
      throw new SessionUnauthorizedError('Authentication required');
    }

    let claims: SessionClaims;
    try {
      claims = await verifySessionToken(
        token,
        requireGoogleAuth(this.config).sessionSecret,
      );
    } catch (err) {
      if (err instanceof InvalidSessionTokenError) {
        throw new SessionUnauthorizedError('Session is not usable');
      }
      throw err;
    }

    if (claims.scope !== this.scope) {
      throw new SessionUnauthorizedError('Session is of the wrong kind');
    }

    // Read the role from the row, never from the token: a suspension or a
    // demotion has to take effect before the session expires.
    const user = await this.users.findById(claims.userId);
    if (!user) {
      throw new SessionUnauthorizedError('Session is not usable');
    }

    req.session = claims;
    req.user = {
      id: user.id,
      email: user.email,
      systemRole: user.systemRole,
    };
    return true;
  }
}

/** Requires a full-access session: someone already on the roster. */
@Injectable()
export class SessionGuard extends SessionGuardBase {
  protected readonly scope = SessionScope.FullAccess;
}

/** Requires a provisional session: an invite holder mid-onboarding. */
@Injectable()
export class ProvisionalSessionGuard extends SessionGuardBase {
  protected readonly scope = SessionScope.Provisional;
}
