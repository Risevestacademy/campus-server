import type { ExecutionContext } from '@nestjs/common';

import { SystemRole, UserStatus, type User } from '../users/schema.js';
import type { UsersService } from '../users/users.service.js';
import { SessionUnauthorizedError } from './auth.exceptions.js';
import { SESSION_COOKIE } from './session-cookie.js';
import { SessionScope, signSessionToken } from '@campus/session';
import { ProvisionalSessionGuard, SessionGuard } from './session.guard.js';

const SECRET = 'a-session-secret-of-at-least-32-characters';

const config = {
  FF_GOOGLE_AUTH_ENABLED: true,
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_CALLBACK_URL: 'http://localhost:3000/v1/auth/google/callback',
  AUTH_STATE_SECRET: 'a-state-secret-of-at-least-32-characters',
  AUTH_SESSION_SECRET: SECRET,
  CORS_ORIGINS: 'https://campus.example.com',
} as never;

function user(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'ada@campus.local',
    systemRole: SystemRole.User,
    status: UserStatus.Active,
    sessionEpoch: 0,
    ...overrides,
  } as User;
}

function users(found: User | null = user()): UsersService {
  return {
    findById: vi.fn().mockResolvedValue(found),
  } as unknown as UsersService;
}

function context(headers: Record<string, string>, method = 'GET') {
  const req: Record<string, unknown> = { headers, method };
  return {
    req,
    ctx: {
      switchToHttp: () => ({ getRequest: () => req }),
    } as ExecutionContext,
  };
}

async function tokenFor(scope: SessionScope, inviteId?: string, epoch = 0) {
  const { token } = await signSessionToken(
    { epoch, userId: 'user-1', email: 'ada@campus.local', scope, inviteId },
    { secret: SECRET, ttlMinutes: 30 },
  );
  return token;
}

describe('SessionGuard', () => {
  it('accepts a full-access cookie and puts the caller on the request', async () => {
    const token = await tokenFor(SessionScope.FullAccess);
    const { req, ctx } = context({ cookie: `${SESSION_COOKIE}=${token}` });

    await expect(
      new SessionGuard(
        config,
        users(user({ systemRole: SystemRole.Admin })),
      ).canActivate(ctx),
    ).resolves.toBe(true);

    expect(req.user).toMatchObject({
      id: 'user-1',
      email: 'ada@campus.local',
      systemRole: SystemRole.Admin,
    });
  });

  it('accepts the same token as a bearer header, for API clients', async () => {
    const token = await tokenFor(SessionScope.FullAccess);
    const { ctx } = context({ authorization: `Bearer ${token}` });

    await expect(
      new SessionGuard(config, users()).canActivate(ctx),
    ).resolves.toBe(true);
  });

  /**
   * The role is read from the row, not the token, so a demotion or suspension
   * takes effect immediately instead of when the session happens to expire.
   */
  it('reports the role the database holds, not the one in the token', async () => {
    const token = await tokenFor(SessionScope.FullAccess);
    const { req, ctx } = context({ cookie: `${SESSION_COOKIE}=${token}` });

    await new SessionGuard(
      config,
      users(user({ systemRole: SystemRole.User })),
    ).canActivate(ctx);

    expect((req.user as { systemRole: string }).systemRole).toBe(
      SystemRole.User,
    );
  });

  it('turns away a provisional session', async () => {
    const token = await tokenFor(SessionScope.Provisional, 'invite-1');
    const { ctx } = context({ cookie: `${SESSION_COOKIE}=${token}` });

    await expect(
      new SessionGuard(config, users()).canActivate(ctx),
    ).rejects.toThrow(SessionUnauthorizedError);
  });

  it('turns away a caller with no session at all', async () => {
    const { ctx } = context({});

    await expect(
      new SessionGuard(config, users()).canActivate(ctx),
    ).rejects.toThrow(SessionUnauthorizedError);
  });

  it('turns away a suspended account holding a live session', async () => {
    const token = await tokenFor(SessionScope.FullAccess);
    const { ctx } = context({ cookie: `${SESSION_COOKIE}=${token}` });

    await expect(
      new SessionGuard(
        config,
        users(user({ status: UserStatus.Suspended })),
      ).canActivate(ctx),
    ).rejects.toThrow(SessionUnauthorizedError);
  });

  /**
   * The session cookie is SameSite=None across sites, so the browser sends it
   * on a cross-site form POST too. The origin is what rules that out.
   */
  it('turns away a cookie-authenticated write from an unknown origin', async () => {
    const token = await tokenFor(SessionScope.FullAccess);
    const { ctx } = context(
      { cookie: `${SESSION_COOKIE}=${token}`, origin: 'https://evil.example' },
      'POST',
    );

    await expect(
      new SessionGuard(config, users()).canActivate(ctx),
    ).rejects.toThrow(SessionUnauthorizedError);
  });

  it('allows a cookie-authenticated write from the web app', async () => {
    const token = await tokenFor(SessionScope.FullAccess);
    const { ctx } = context(
      {
        cookie: `${SESSION_COOKIE}=${token}`,
        origin: 'https://campus.example.com',
      },
      'POST',
    );

    await expect(
      new SessionGuard(config, users()).canActivate(ctx),
    ).resolves.toBe(true);
  });

  /** A bearer token is not attached by a browser, so no origin is needed. */
  it('allows a bearer write with no origin at all', async () => {
    const token = await tokenFor(SessionScope.FullAccess);
    const { ctx } = context({ authorization: `Bearer ${token}` }, 'POST');

    await expect(
      new SessionGuard(config, users()).canActivate(ctx),
    ).resolves.toBe(true);
  });

  it('turns everything away when sign-in is switched off', async () => {
    const token = await tokenFor(SessionScope.FullAccess);
    const { ctx } = context({ cookie: `${SESSION_COOKIE}=${token}` });
    const off = {
      ...(config as object),
      FF_GOOGLE_AUTH_ENABLED: false,
    } as never;

    await expect(
      new SessionGuard(off, users()).canActivate(ctx),
    ).rejects.toThrow(SessionUnauthorizedError);
  });

  it('turns away a session whose account has since gone', async () => {
    const token = await tokenFor(SessionScope.FullAccess);
    const { ctx } = context({ cookie: `${SESSION_COOKIE}=${token}` });

    await expect(
      new SessionGuard(config, users(null)).canActivate(ctx),
    ).rejects.toThrow(SessionUnauthorizedError);
  });
});

describe('ProvisionalSessionGuard', () => {
  it('accepts a provisional session and carries the invite through', async () => {
    const token = await tokenFor(SessionScope.Provisional, 'invite-1');
    const { req, ctx } = context({ cookie: `${SESSION_COOKIE}=${token}` });

    await expect(
      new ProvisionalSessionGuard(config, users()).canActivate(ctx),
    ).resolves.toBe(true);

    expect((req.session as { inviteId: string }).inviteId).toBe('invite-1');
  });

  it('turns away a full-access session, which has no onboarding left', async () => {
    const token = await tokenFor(SessionScope.FullAccess);
    const { ctx } = context({ cookie: `${SESSION_COOKIE}=${token}` });

    await expect(
      new ProvisionalSessionGuard(config, users()).canActivate(ctx),
    ).rejects.toThrow(SessionUnauthorizedError);
  });

  describe('session epoch', () => {
    const attempt = async (tokenEpoch: number, rowEpoch: number) => {
      const token = await tokenFor(
        SessionScope.FullAccess,
        undefined,
        tokenEpoch,
      );
      const { ctx } = context({ authorization: `Bearer ${token}` });
      return new SessionGuard(
        config,
        users(user({ sessionEpoch: rowEpoch })),
      ).canActivate(ctx);
    };

    it('accepts a token signed with the epoch the account has now', async () => {
      await expect(attempt(4, 4)).resolves.toBe(true);
    });

    // The whole point: the token is well signed and unexpired, and is still
    // refused, because the account's sessions were ended after it was minted.
    it('refuses a token from before the account sessions were revoked', async () => {
      await expect(attempt(4, 5)).rejects.toThrow('Session has been revoked');
      await expect(attempt(4, 5)).rejects.toBeInstanceOf(
        SessionUnauthorizedError,
      );
    });

    // An epoch only goes up, so a token ahead of the row is not one this
    // account was issued. Equality, not "at least", refuses it too.
    it('refuses a token whose epoch is ahead of the account', async () => {
      await expect(attempt(6, 5)).rejects.toThrow('Session has been revoked');
    });

    it('holds a provisional session to the same rule', async () => {
      const token = await tokenFor(SessionScope.Provisional, 'invite-1', 0);
      const { ctx } = context({ authorization: `Bearer ${token}` });

      await expect(
        new ProvisionalSessionGuard(
          config,
          users(user({ sessionEpoch: 1 })),
        ).canActivate(ctx),
      ).rejects.toThrow('Session has been revoked');
    });
  });
});
