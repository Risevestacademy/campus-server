import { Inject, Injectable } from '@nestjs/common';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import type { AccessGrant } from '../cohorts/cohort-members.service.js';
import { SessionUnauthorizedError } from './auth.exceptions.js';
import type { Invite } from '../invites/schema.js';
import type { User } from '../users/schema.js';
import { requireGoogleAuth } from './google-auth.settings.js';
import {
  SessionScope,
  signSessionToken,
  type SessionScope as Scope,
} from '@campus/session';

/**
 * The configured lifetime, shortened when the grant behind it ends sooner.
 *
 * No floor. Rounding a remainder up to a minute hands back access past the
 * deadline, which is the whole thing this is here to prevent; a token with
 * seconds left simply sends the browser to sign-in, where the gate refuses
 * them properly. A grant already over is rejected by the caller, so the
 * remainder here is always positive.
 */
function cappedTtlMinutes(
  ttlMinutes: number,
  endsAt: Date | null,
  now: Date,
): number {
  if (endsAt === null) {
    return ttlMinutes;
  }
  return Math.min(ttlMinutes, (endsAt.getTime() - now.getTime()) / 60_000);
}

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

  /**
   * Someone already on the roster: nothing left to finish.
   *
   * Takes the grant that authorised them rather than looking one up, so the
   * deadline is the one the decision was made against. Reading it again here
   * would be a second clock: a guest crossing their deadline between the two
   * reads looks authorised to the first and unexpiring to the second, and
   * walks away with a full-length token for a visit that has ended.
   *
   * The token never outlives that grant. SessionGuard re-reads the user row
   * per request but not their memberships, so without this cap a visit that
   * ended at 09:00 would keep working until the token happened to lapse, up
   * to AUTH_SESSION_TTL_MINUTES later. Capping at mint time also covers
   * `world`, which only verifies the token and knows nothing of cohorts.
   *
   * A grant that has already ended is refused outright. By the time we are
   * minting, its holder is somebody the sign-in gate would now turn away.
   */
  async issueFullAccess(
    user: User,
    grant: AccessGrant,
    now: Date = new Date(),
  ): Promise<IssuedSession> {
    const endsAt = grant.endsAt;
    if (endsAt !== null && endsAt.getTime() <= now.getTime()) {
      throw new SessionUnauthorizedError('Access has already ended');
    }
    const { token, expiresAt } = await signSessionToken(
      { userId: user.id, email: user.email, scope: SessionScope.FullAccess },
      {
        secret: this.secret,
        ttlMinutes: cappedTtlMinutes(
          this.config.AUTH_SESSION_TTL_MINUTES,
          endsAt,
          now,
        ),
      },
      now,
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
