import type { ExecutionContext } from '@nestjs/common';

import { SystemRole, UserStatus, type User } from '../users/schema.js';
import type { UsersService } from '../users/users.service.js';
import { SessionUnauthorizedError } from './auth.exceptions.js';
import { SESSION_COOKIE } from './session-cookie.js';
import { SessionScope, signSessionToken } from './session-token.js';
import { ProvisionalSessionGuard, SessionGuard } from './session.guard.js';

const SECRET = 'a-session-secret-of-at-least-32-characters';

const config = {
  FF_GOOGLE_AUTH_ENABLED: true,
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_CALLBACK_URL: 'http://localhost:3000/v1/auth/google/callback',
  AUTH_STATE_SECRET: 'a-state-secret-of-at-least-32-characters',
  AUTH_SESSION_SECRET: SECRET,
} as never;

function user(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'ada@campus.local',
    systemRole: SystemRole.User,
    status: UserStatus.Active,
    ...overrides,
  } as User;
}

function users(found: User | null = user()): UsersService {
  return { findById: vi.fn().mockResolvedValue(found) } as unknown as UsersService;
}

function context(headers: Record<string, string>) {
  const req: Record<string, unknown> = { headers };
  return {
    req,
    ctx: {
      switchToHttp: () => ({ getRequest: () => req }),
    } as ExecutionContext,
  };
}

async function tokenFor(scope: SessionScope, inviteId?: string) {
  const { token } = await signSessionToken(
    { userId: 'user-1', email: 'ada@campus.local', scope, inviteId },
    { secret: SECRET, ttlMinutes: 30 },
  );
  return token;
}

describe('SessionGuard', () => {
  it('accepts a full-access cookie and puts the caller on the request', async () => {
    const token = await tokenFor(SessionScope.FullAccess);
    const { req, ctx } = context({ cookie: `${SESSION_COOKIE}=${token}` });

    await expect(
      new SessionGuard(config, users(user({ systemRole: SystemRole.Admin }))).canActivate(ctx),
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

    await expect(new SessionGuard(config, users()).canActivate(ctx)).resolves.toBe(
      true,
    );
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

    expect((req.user as { systemRole: string }).systemRole).toBe(SystemRole.User);
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
});
