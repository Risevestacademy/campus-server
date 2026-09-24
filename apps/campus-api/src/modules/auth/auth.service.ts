import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { CohortMembersService } from '../cohorts/cohort-members.service.js';
import { InvitesService } from '../invites/invites.service.js';
import type { Invite } from '../invites/schema.js';
import type { User } from '../users/schema.js';
import { isAdmin, isSuspended, UsersService } from '../users/users.service.js';
import {
  AccountSuspendedError,
  GoogleSignInFailedError,
  InviteRequiredError,
} from './auth.exceptions.js';
import { GoogleOAuthService } from './google-oauth.service.js';

/**
 * Who signed in, and how far they get.
 *
 * `full_access` is someone already on the campus roster. `provisional` is
 * someone holding an invite they have not accepted yet, who still has
 * onboarding to finish before they belong anywhere.
 */
export type SignInOutcome =
  | { kind: 'full_access'; user: User }
  | { kind: 'provisional'; user: User; invite: Invite };

@Injectable()
export class AuthService {
  constructor(
    private readonly google: GoogleOAuthService,
    private readonly users: UsersService,
    private readonly invites: InvitesService,
    private readonly members: CohortMembersService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuthService.name);
  }


  async completeGoogleSignIn(code: string): Promise<SignInOutcome> {
    const identity = await this.google.exchangeCode(code);

    // An unverified address proves control of a Google account, not of the
    // mailbox — and the mailbox is what an invite was sent to.
    if (!identity.emailVerified) {
      throw new GoogleSignInFailedError('unverified_email');
    }

    const email = identity.email.trim().toLowerCase();
    const normalized = { ...identity, email };

    const existing = await this.users.resolveByGoogleIdentity(normalized);

    if (existing && isSuspended(existing)) {
      this.logger.warn(
        { userId: existing.id },
        'suspended account attempted to sign in',
      );
      throw new AccountSuspendedError();
    }

    if (existing && (await this.bypassesInvite(existing))) {
      await this.users.recordLogin(existing.id);
      this.logger.info(
        { userId: existing.id, outcome: 'full_access' },
        'google sign-in',
      );
      return { kind: 'full_access', user: existing };
    }

    const invite = await this.invites.findUsableForEmail(email);
    if (!invite) {
      // Covers both the stranger and the former member whose row outlived
      // their place here. Neither gets an account created for them.
      this.logger.info(
        { userId: existing?.id ?? null, outcome: 'rejected' },
        'google sign-in without a usable invite',
      );
      throw new InviteRequiredError();
    }

    const user =
      existing ?? (await this.users.createFromGoogleIdentity(normalized));
    await this.users.recordLogin(user.id);
    this.logger.info(
      { userId: user.id, inviteId: invite.id, outcome: 'provisional' },
      'google sign-in',
    );

    return { kind: 'provisional', user, invite };
  }

  private async bypassesInvite(user: User): Promise<boolean> {
    return isAdmin(user) || this.members.hasActiveMembership(user.id);
  }
}
