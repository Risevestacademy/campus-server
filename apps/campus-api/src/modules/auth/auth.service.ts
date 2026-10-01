import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  CohortMembersService,
  type AccessGrant,
} from '../cohorts/cohort-members.service.js';
import { InvitesService } from '../invites/invites.service.js';
import type { Invite } from '../invites/schema.js';
import type { User } from '../users/schema.js';
import { isAdmin, isSuspended, UsersService } from '../users/users.service.js';
import {
  AccountSuspendedError,
  GoogleSignInFailedError,
  InviteRequiredError,
} from './auth.exceptions.js';
import {
  GoogleOAuthService,
  type VerifiedGoogleIdentity,
} from './google-oauth.service.js';

/**
 * Who signed in, and how far they get.
 *
 * `full_access` is someone already on the campus roster, who may also hold
 * an invite to another cohort — a member can belong to several. `provisional`
 * is someone holding an invite they have not accepted yet, who still has
 * onboarding to finish before they belong anywhere.
 */
export type SignInOutcome =
  | {
      kind: 'full_access';
      user: User;
      grant: AccessGrant;
      /** A pending invite addressed to them, to answer without losing access. */
      pendingInvite: Invite | null;
    }
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
    return this.admit(await this.google.exchangeCode(code));
  }

  /**
   * The same decision for a native app, which arrives with the id_token
   * Google's SDK gave it rather than a code from a redirect.
   */
  async completeGoogleIdTokenSignIn(idToken: string): Promise<SignInOutcome> {
    return this.admit(await this.google.verifyIdToken(idToken));
  }

  private async admit(
    identity: VerifiedGoogleIdentity,
  ): Promise<SignInOutcome> {
    // An unverified address proves control of a Google account, not of the
    // mailbox — and the mailbox is what an invite was sent to.
    if (!identity.emailVerified) {
      throw new GoogleSignInFailedError('unverified_email');
    }

    const email = identity.email.trim().toLowerCase();
    const normalized = { ...identity, email };

    // Read-only until the outcome is decided: a caller who is turned away
    // must not leave their Google subject bound to somebody's account.
    const existing = await this.users.findForGoogleIdentity(normalized);

    if (existing && isSuspended(existing)) {
      this.logger.warn(
        { userId: existing.id },
        'suspended account attempted to sign in',
      );
      throw new AccountSuspendedError();
    }

    const grant = existing ? await this.resolveAccess(existing) : null;
    const invite = await this.invites.findUsableForEmail(email);
    if (existing && grant) {
      const user = await this.linkIfUnbound(existing, normalized);
      await this.users.recordLogin(user.id);
      this.logger.info(
        {
          userId: user.id,
          outcome: 'full_access',
          endsAt: grant.endsAt,
          inviteId: invite?.id ?? null,
        },
        'google sign-in',
      );
      return { kind: 'full_access', user, grant, pendingInvite: invite };
    }

    if (!invite) {
      // Covers both the stranger and the former member whose row outlived
      // their place here. Neither gets an account created for them.
      this.logger.info(
        { userId: existing?.id ?? null, outcome: 'rejected' },
        'google sign-in without a usable invite',
      );
      throw new InviteRequiredError();
    }

    const user = existing
      ? await this.linkIfUnbound(existing, normalized)
      : await this.users.createFromGoogleIdentity(normalized);
    await this.users.recordLogin(user.id);
    this.logger.info(
      { userId: user.id, inviteId: invite.id, outcome: 'provisional' },
      'google sign-in',
    );

    return { kind: 'provisional', user, invite };
  }

  /** A row found by address still needs the subject written onto it. */
  private async linkIfUnbound(
    user: User,
    identity: VerifiedGoogleIdentity,
  ): Promise<User> {
    if (user.providerId) {
      return user;
    }
    return (await this.users.linkGoogleIdentity(identity)) ?? user;
  }

  /**
   * What lets somebody past the invite wall, and how long it lasts — one
   * answer rather than a boolean the caller then has to date separately.
   *
   * An admin is admitted on their role, which nothing expires, so their
   * session is not bounded by a cohort membership they happen to also hold.
   * Everyone else is admitted by a live membership, and the soonest of those
   * deadlines is what bounds them.
   */
  private async resolveAccess(user: User): Promise<AccessGrant | null> {
    if (isAdmin(user)) {
      return { endsAt: null };
    }
    return this.members.resolveActiveAccess(user.id);
  }
}
