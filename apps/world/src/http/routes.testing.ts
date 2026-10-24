import {
  SessionScope,
  signSessionToken,
  type SessionScope as Scope,
} from '@campus/session';

import type { Account } from '../infra/accounts.js';
import { loadEnv } from '../infra/env.js';

/** What world's HTTP route specs share. Test-only: left out of the build. */
export const SECRET = 'a-world-session-secret-of-at-least-32-chars';
export const ORIGIN = 'http://localhost:3002';

export function routeEnv(extra: Record<string, string> = {}) {
  return loadEnv({
    AUTH_SESSION_SECRET: SECRET,
    DEPLOYMENT_ENVIRONMENT: 'development',
    DATABASE_URL: 'postgres://unused',
    CORS_ORIGINS: ORIGIN,
    FF_LOG_LEVEL: 'fatal',
    ...extra,
  } as NodeJS.ProcessEnv);
}

/** An account lookup a spec steers: who is an admin, suspended or gone. */
export function routeAccounts() {
  const admins = new Set<string>();
  const suspended = new Set<string>();
  const gone = new Set<string>();
  return {
    admins,
    suspended,
    gone,
    clear() {
      admins.clear();
      suspended.clear();
      gone.clear();
    },
    find: async (id: string): Promise<Account | null> =>
      gone.has(id)
        ? null
        : {
            id,
            suspended: suspended.has(id),
            sessionEpoch: 0,
            admin: admins.has(id),
            systemRole: admins.has(id) ? 'admin' : 'user',
            displayName: null,
            spriteKey: null,
          },
    liveSessions: async () => new Set<string>(),
    liveMembership: async () => false,
    liveMemberships: async () => new Set<string>(),
    memberships: async () => new Map(),
    spacesOn: async () => new Map(),
    onProfileChanged: async () => undefined,
    onSpacesChanged: async () => undefined,
    close: async () => undefined,
  };
}

export async function sessionToken(
  userId = 'ada',
  scope: Scope = SessionScope.FullAccess,
): Promise<string> {
  const { token } = await signSessionToken(
    { epoch: 0, userId, email: `${userId}@campus.local`, scope },
    { secret: SECRET, ttlMinutes: 15 },
  );
  return token;
}
