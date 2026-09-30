import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';

/**
 * What a session is allowed to do. `provisional` belongs to someone holding
 * an invite they have not accepted: enough to finish onboarding and nothing
 * else. `full_access` belongs to someone already on the roster.
 *
 * The two are separate scopes rather than one token with a flag so that a
 * half-onboarded caller cannot reach an ordinary route by accident — a guard
 * asks for the scope it needs.
 */
export const SessionScope = {
  Provisional: 'provisional',
  FullAccess: 'full_access',
} as const;

export type SessionScope = (typeof SessionScope)[keyof typeof SessionScope];

export interface SessionClaims {
  userId: string;
  email: string;
  scope: SessionScope;
  systemRole?: string;
  role?: string;
  cohortId?: string;
  /** Present on provisional sessions: the invite still to be accepted. */
  inviteId?: string;
  /**
   * Present on full-access sessions: the refresh-token family this access
   * token belongs to, so something holding a connection longer than one
   * access token (world's socket) can ask whether the login behind it is
   * still alive — signed out, revoked, or no longer being refreshed.
   */
  sessionId?: string;
  expiresAt: Date;
}

const ISSUER = 'campus-api';
const AUDIENCE = 'campus';

export class InvalidSessionTokenError extends Error {}

export interface SessionTokenSettings {
  secret: string;
  ttlMinutes: number;
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signSessionToken(
  claims: Omit<SessionClaims, 'expiresAt' | 'systemRole'> & {
    systemRole?: string;
  },
  settings: SessionTokenSettings,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  // Whole seconds, because that is all a JWT `exp` carries. Keeping the
  // milliseconds here would hand the caller — and the cookie — an expiry up
  // to a second later than the token's own.
  const expiresAt = new Date(
    Math.floor((now.getTime() + settings.ttlMinutes * 60_000) / 1000) * 1000,
  );

  const token = await new SignJWT({
    email: claims.email,
    scope: claims.scope,
    system_role: claims.systemRole ?? 'user',
    ...(claims.role ? { role: claims.role } : {}),
    ...(claims.cohortId ? { cohort_id: claims.cohortId } : {}),
    ...(claims.inviteId ? { inviteId: claims.inviteId } : {}),
    ...(claims.sessionId ? { sid: claims.sessionId } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(key(settings.secret));

  return { token, expiresAt };
}

/**
 * Rejects anything it cannot fully vouch for — bad signature, wrong issuer or
 * audience, expired, or a scope this build does not know. Callers get one
 * error type, because the difference never changes what they do about it.
 */
export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<SessionClaims> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, key(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    }));
  } catch (err) {
    // Only token problems become a 401. Anything else — a missing secret, a
    // programming error — is a fault, and must not be disguised as a caller
    // presenting a bad token.
    if (err instanceof joseErrors.JOSEError) {
      throw new InvalidSessionTokenError('session token is not usable');
    }
    throw err;
  }

  const scope = payload['scope'];
  const email = payload['email'];
  const systemRole = payload['system_role'];
  const role = payload['role'];
  const cohortId = payload['cohort_id'];
  const inviteId = payload['inviteId'];
  const sessionId = payload['sid'];

  if (
    !payload.sub ||
    typeof email !== 'string' ||
    typeof systemRole !== 'string' ||
    (scope !== SessionScope.Provisional && scope !== SessionScope.FullAccess) ||
    (role !== undefined && typeof role !== 'string') ||
    (cohortId !== undefined && typeof cohortId !== 'string') ||
    (inviteId !== undefined && typeof inviteId !== 'string') ||
    (sessionId !== undefined && typeof sessionId !== 'string') ||
    payload.exp === undefined
  ) {
    throw new InvalidSessionTokenError('session token is missing claims');
  }

  return {
    userId: payload.sub,
    email,
    scope,
    systemRole,
    role,
    cohortId,
    inviteId,
    sessionId,
    expiresAt: new Date(payload.exp * 1000),
  };
}
