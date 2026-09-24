import { Inject, Injectable } from '@nestjs/common';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import type { Invite } from '../invites/schema.js';
import type { User } from '../users/schema.js';
import { requireGoogleAuth } from './google-auth.settings.js';
import {
  SessionScope,
  signSessionToken,
  type SessionScope as Scope,
} from './session-token.js';

export interface IssuedSession {
  token: string;
  expiresAt: Date;
  scope: Scope;
  /** Where the browser is sent once the cookie is set. */
  redirectPath: string;
}

/**
 * Mints the session a completed Google sign-in earns. Refresh tokens are a
 * separate ticket; until then a session simply expires and sign-in is
 * repeated, which is cheap because Google keeps the account selected.
 */
@Injectable()
export class SessionIssuer {
  constructor(@Inject(CONFIG) private readonly config: Env) {}

  /** Someone already on the roster: nothing left to finish. */
  async issueFullAccess(user: User): Promise<IssuedSession> {
    const { token, expiresAt } = await signSessionToken(
      { userId: user.id, email: user.email, scope: SessionScope.FullAccess },
      {
        secret: this.secret,
        ttlMinutes: this.config.AUTH_SESSION_TTL_MINUTES,
      },
    );

    return {
      token,
      expiresAt,
      scope: SessionScope.FullAccess,
      redirectPath: '/',
    };
  }

  /**
   * Someone holding an invite they have not accepted. The invite travels in
   * the token so the accept route knows which one is being answered without
   * trusting the caller to say.
   */
  async issueProvisional(user: User, invite: Invite): Promise<IssuedSession> {
    const { token, expiresAt } = await signSessionToken(
      {
        userId: user.id,
        email: user.email,
        scope: SessionScope.Provisional,
        inviteId: invite.id,
      },
      {
        secret: this.secret,
        ttlMinutes: this.config.AUTH_PROVISIONAL_TTL_MINUTES,
      },
    );

    return {
      token,
      expiresAt,
      scope: SessionScope.Provisional,
      redirectPath: '/onboarding',
    };
  }

  private get secret(): string {
    return requireGoogleAuth(this.config).sessionSecret;
  }
}
