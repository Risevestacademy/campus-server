import type { PinoLogger } from 'nestjs-pino';

import type { CohortMembersService } from '../cohorts/cohort-members.service.js';
import type { Invite } from '../invites/schema.js';
import type { InvitesService } from '../invites/invites.service.js';
import { InviteStatus } from '../invites/schema.js';
import { SystemRole, UserStatus } from '../users/schema.js';
import type { User } from '../users/schema.js';
import { GOOGLE_PROVIDER } from '../users/users.service.js';
import type { UsersService } from '../users/users.service.js';
import {
  AccountSuspendedError,
  GoogleSignInFailedError,
  InviteRequiredError,
} from './auth.exceptions.js';
import { AuthService } from './auth.service.js';
import type {
  GoogleOAuthService,
  VerifiedGoogleIdentity,
} from './google-oauth.service.js';

const google = { exchangeCode: vi.fn() };
const users = {
  findForGoogleIdentity: vi.fn(),
  linkGoogleIdentity: vi.fn(),
  createFromGoogleIdentity: vi.fn(),
  recordLogin: vi.fn(),
};
const invites = { findUsableForEmail: vi.fn() };
const members = { hasActiveMembership: vi.fn() };
const logger = { info: vi.fn(), warn: vi.fn(), setContext: vi.fn() };

const service = new AuthService(
  google as unknown as GoogleOAuthService,
  users as unknown as UsersService,
  invites as unknown as InvitesService,
  members as unknown as CohortMembersService,
  logger as unknown as PinoLogger,
);

function verifiedIdentity(
  overrides: Partial<VerifiedGoogleIdentity> = {},
): VerifiedGoogleIdentity {
  return {
    subject: 'google-sub-1',
    email: 'ada@campus.local',
    emailVerified: true,
    firstName: 'Ada',
    lastName: 'Lovelace',
    displayName: 'Ada Lovelace',
    avatarUrl: null,
    ...overrides,
  };
}

function user(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'ada@campus.local',
    provider: GOOGLE_PROVIDER,
    providerId: 'google-sub-1',
    firstName: null,
    lastName: null,
    displayName: null,
    avatarUrl: null,
    systemRole: SystemRole.User,
    status: UserStatus.Active,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    phone: null,
    bio: null,
    spriteKey: null,
    ...overrides,
  };
}

function invite(): Invite {
  return {
    id: 'invite-1',
    email: 'ada@campus.local',
    cohortId: 'cohort-1',
    cohortTrackId: 'cohort-track-1',
    mentorshipGroupId: null,
    cohortRole: null,
    systemRole: SystemRole.User,
    status: InviteStatus.Pending,
    expiresAt: new Date(Date.now() + 86_400_000),
    tokenHash: 'hash-1',
    invitedBy: 'admin-1',
    acceptedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  google.exchangeCode.mockResolvedValue(verifiedIdentity());
  users.findForGoogleIdentity.mockResolvedValue(null);
  users.linkGoogleIdentity.mockImplementation((identity: { subject: string }) =>
    Promise.resolve(user({ providerId: identity.subject })),
  );
  users.recordLogin.mockResolvedValue(undefined);
  invites.findUsableForEmail.mockResolvedValue(null);
  members.hasActiveMembership.mockResolvedValue(false);
});

describe('completeGoogleSignIn', () => {
  it('refuses an account whose address Google has not verified', async () => {
    google.exchangeCode.mockResolvedValue(
      verifiedIdentity({ emailVerified: false }),
    );

    await expect(service.completeGoogleSignIn('code')).rejects.toThrow(
      GoogleSignInFailedError,
    );
    expect(users.findForGoogleIdentity).not.toHaveBeenCalled();
  });

  it('turns a suspended account away before anything else is considered', async () => {
    users.findForGoogleIdentity.mockResolvedValue(
      user({ status: UserStatus.Suspended, systemRole: SystemRole.Admin }),
    );

    await expect(service.completeGoogleSignIn('code')).rejects.toThrow(
      AccountSuspendedError,
    );
    expect(users.recordLogin).not.toHaveBeenCalled();
    expect(invites.findUsableForEmail).not.toHaveBeenCalled();
  });

  it('lets an admin straight in without consulting the roster', async () => {
    users.findForGoogleIdentity.mockResolvedValue(
      user({ systemRole: SystemRole.Admin }),
    );

    const outcome = await service.completeGoogleSignIn('code');

    expect(outcome.kind).toBe('full_access');
    expect(members.hasActiveMembership).not.toHaveBeenCalled();
    expect(invites.findUsableForEmail).not.toHaveBeenCalled();
    expect(users.recordLogin).toHaveBeenCalledWith('user-1');
  });

  it('lets a current member straight in', async () => {
    users.findForGoogleIdentity.mockResolvedValue(user());
    members.hasActiveMembership.mockResolvedValue(true);

    const outcome = await service.completeGoogleSignIn('code');

    expect(outcome.kind).toBe('full_access');
    expect(invites.findUsableForEmail).not.toHaveBeenCalled();
  });

  it('creates an account for an invited stranger', async () => {
    invites.findUsableForEmail.mockResolvedValue(invite());
    users.createFromGoogleIdentity.mockResolvedValue(user());

    const outcome = await service.completeGoogleSignIn('code');

    expect(outcome.kind).toBe('provisional');
    expect(users.createFromGoogleIdentity).toHaveBeenCalledOnce();
    expect(users.recordLogin).toHaveBeenCalledWith('user-1');
  });

  it('reuses the account of someone who signed in but never onboarded', async () => {
    users.findForGoogleIdentity.mockResolvedValue(user());
    invites.findUsableForEmail.mockResolvedValue(invite());

    const outcome = await service.completeGoogleSignIn('code');

    expect(outcome.kind).toBe('provisional');
    expect(users.createFromGoogleIdentity).not.toHaveBeenCalled();
  });

  it('rejects an uninvited stranger without leaving an account behind', async () => {
    await expect(service.completeGoogleSignIn('code')).rejects.toThrow(
      InviteRequiredError,
    );
    expect(users.createFromGoogleIdentity).not.toHaveBeenCalled();
    expect(users.recordLogin).not.toHaveBeenCalled();
  });

  /**
   * Being turned away is not a write. Binding the subject first would leave
   * a rejected caller's Google account attached to a seeded or invited row,
   * and their name and picture copied onto it.
   */
  it('binds nothing to an existing row when the caller is turned away', async () => {
    users.findForGoogleIdentity.mockResolvedValue(
      user({ providerId: null, systemRole: SystemRole.User }),
    );
    members.hasActiveMembership.mockResolvedValue(false);

    await expect(service.completeGoogleSignIn('code')).rejects.toThrow(
      InviteRequiredError,
    );

    expect(users.linkGoogleIdentity).not.toHaveBeenCalled();
    expect(users.recordLogin).not.toHaveBeenCalled();
  });

  it('binds nothing when the account is suspended', async () => {
    users.findForGoogleIdentity.mockResolvedValue(
      user({ providerId: null, status: UserStatus.Suspended }),
    );

    await expect(service.completeGoogleSignIn('code')).rejects.toThrow(
      AccountSuspendedError,
    );

    expect(users.linkGoogleIdentity).not.toHaveBeenCalled();
    expect(users.recordLogin).not.toHaveBeenCalled();
  });

  /**
   * A dismissed student keeps their membership row — the schema clears
   * `left_at` on return rather than writing a second one — so "has a row" is
   * not the same question as "is still here".
   */
  it('rejects a former member whose row outlived their place here', async () => {
    users.findForGoogleIdentity.mockResolvedValue(user());
    members.hasActiveMembership.mockResolvedValue(false);

    await expect(service.completeGoogleSignIn('code')).rejects.toThrow(
      InviteRequiredError,
    );
    expect(users.recordLogin).not.toHaveBeenCalled();
  });

  it('carries the message the product asked for', async () => {
    await expect(service.completeGoogleSignIn('code')).rejects.toThrow(
      'No invite found for this email',
    );
  });

  it('lowercases the address before it looks anything up', async () => {
    google.exchangeCode.mockResolvedValue(
      verifiedIdentity({ email: 'Ada@Campus.Local' }),
    );
    invites.findUsableForEmail.mockResolvedValue(invite());
    users.createFromGoogleIdentity.mockResolvedValue(user());

    await service.completeGoogleSignIn('code');

    expect(invites.findUsableForEmail).toHaveBeenCalledWith('ada@campus.local');
    expect(users.createFromGoogleIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ada@campus.local' }),
    );
  });

  it('keeps addresses out of the logs', async () => {
    users.findForGoogleIdentity.mockResolvedValue(
      user({ systemRole: SystemRole.Admin }),
    );

    await service.completeGoogleSignIn('code');

    const logged = JSON.stringify(logger.info.mock.calls);
    expect(logged).not.toContain('ada@campus.local');
    expect(logged).toContain('user-1');
  });
});
