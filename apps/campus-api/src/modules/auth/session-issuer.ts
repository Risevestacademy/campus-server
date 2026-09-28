import { Inject, Injectable } from '@nestjs/common';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import { CohortMembersService } from '../cohorts/cohort-members.service.js';
import type { Invite } from '../invites/schema.js';
import type { User } from '../users/schema.js';
import { requireGoogleAuth } from './google-auth.settings.js';
import {
  SessionScope,
  signSessionToken,
  type SessionScope as Scope,
} from '@campus/session';

/**
 * The configured lifetime, shortened when something the session depends on
 * ends sooner. Never below a minute: a token that expires as it is issued
 * would send the browser straight back to sign-in, and the sign-in gate is
 * what should be refusing them at that point.
 */
function cappedTtlMinutes(
  ttlMinutes: number,
  endsAt: Date | null,
  now: Date,
): number {
  if (endsAt === null) {
    return ttlMinutes;
  }
  const untilEnd = (endsAt.getTime() - now.getTime()) / 60_000;
  return Math.max(1, Math.min(ttlMinutes, untilEnd));
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
  constructor(
    @Inject(CONFIG) private readonly config: Env,
    private readonly members: CohortMembersService,
  ) {}

  /**
   * Someone already on the roster: nothing left to finish.
   *
   * The token never outlives the access it stands for. A guest's membership
   * ends on a date, and SessionGuard re-reads the user row per request but
   * not their memberships — so without this cap a visit that ended at 09:00
   * would keep working until the token happened to lapse, up to
   * AUTH_SESSION_TTL_MINUTES later. Capping at mint time also covers
   * `world`, which only verifies the token and knows nothing of cohorts.
   */
  async issueFullAccess(
    user: User,
    now: Date = new Date(),
  ): Promise<IssuedSession> {
    const endsAt = await this.members.soonestAccessExpiry(user.id, now);
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
