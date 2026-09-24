import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import type { AuthenticatedRequest } from '../../shared/auth/authenticated-user.js';
import { isSuspended, UsersService } from '../users/users.service.js';
import { parseCorsOrigins } from '../../infra/config/env.js';
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

/** Methods a cross-site form can send without a preflight to stop it. */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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
    const cookieToken = readSessionCookie(req.headers.cookie);
    const fromCookie = cookieToken !== undefined;
    const token = cookieToken ?? bearer(req.headers.authorization);
    if (!token) {
      throw new SessionUnauthorizedError('Authentication required');
    }

    // On https the session cookie has to be SameSite=None to reach this API
    // at all, which hands the browser's own CSRF protection back. A simple
    // cross-site form POST carries the cookie and needs no preflight, so the
    // origin is checked here instead.
    if (fromCookie && UNSAFE_METHODS.has(req.method ?? '')) {
      this.assertAllowedOrigin(req.headers.origin);
    }

    let secret: string;
    try {
      secret = requireGoogleAuth(this.config).sessionSecret;
    } catch {
      // Sign-in is switched off, so no session can be valid. Unauthorized
      // rather than "not configured": the caller asked about their own
      // credential, not about this route's existence.
      throw new SessionUnauthorizedError('Authentication required');
    }

    let claims: SessionClaims;
    try {
      claims = await verifySessionToken(token, secret);
    } catch (err) {
      if (err instanceof InvalidSessionTokenError) {
        throw new SessionUnauthorizedError('Session is not usable');
      }
      throw err;
    }

    if (claims.scope !== this.scope) {
      throw new SessionUnauthorizedError('Session is of the wrong kind');
    }

    // Read the account from the row, never from the token: a suspension or a
    // demotion has to take effect on the next request, not whenever the
    // session happens to run out.
    const user = await this.users.findById(claims.userId);
    if (!user) {
      throw new SessionUnauthorizedError('Session is not usable');
    }
    if (isSuspended(user)) {
      throw new SessionUnauthorizedError('Account is suspended');
    }

    req.session = claims;
    req.user = {
      id: user.id,
      email: user.email,
      systemRole: user.systemRole,
    };
    return true;
  }

  /**
   * A browser sending the session cookie must say where it is from, and it
   * must be somewhere we serve. Requests with no Origin at all are server to
   * server, where the cookie could not have been attached by a third party.
   */
  private assertAllowedOrigin(origin: string | undefined): void {
    if (origin === undefined) {
      return;
    }
    const allowed = parseCorsOrigins(this.config.CORS_ORIGINS);
    if (!allowed.includes(origin)) {
      throw new SessionUnauthorizedError('Origin is not allowed to use this session');
    }
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
