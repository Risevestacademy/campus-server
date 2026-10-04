import {
  InvalidSessionTokenError,
  SessionScope,
  verifySessionToken,
  type SessionClaims,
} from '@campus/session';

import type { AccountLookup } from '../infra/accounts.js';
import { allowedOrigins, type Env } from '../infra/env.js';

export type Refusal =
  | 'origin_not_allowed'
  | 'no_token'
  | 'token_not_usable'
  | 'wrong_scope'
  | 'account_gone'
  | 'account_suspended'
  | 'session_ended'
  | 'no_cohort'
  | 'not_a_member';

export type UpgradeDecision =
  | { ok: true; claims: SessionClaims; cohortId: string }
  | {
      ok: false;
      refusal: Refusal;
      /**
       * Set only when the account itself was refused — suspended or gone —
       * so the caller can forget anything it kept for them.
       */
      userId?: string;
    };

const SESSION_COOKIE = 'campus_session';

/** Same cookie campus-api sets; the browser sends it on the upgrade. */
export function readSessionCookie(
  header: string | undefined,
): string | undefined {
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function bearer(header: string | undefined): string | undefined {
  if (!header?.startsWith('Bearer ')) return undefined;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : undefined;
}

/**
 * Decides an upgrade before any socket exists.
 *
 * The Origin check is the important half: a WebSocket upgrade is exempt from
 * CORS, so without it any page the user has open could hold a socket into
 * the campus with their cookie attached. Browsers always send Origin on an
 * upgrade; a caller that sends none is not a browser, and has to carry a
 * bearer token instead of relying on a cookie it could not have been given.
 *
 * Only full-access sessions get in. Somebody mid-onboarding has no place in
 * the world yet.
 *
 * The token is checked against the account it names, because a token says
 * who somebody was when they signed in and cannot say whether they still
 * belong here — and, when it names one, against the login it came from,
 * which may have been signed out since.
 *
 * The cohort comes last, so a refusal tells somebody who is not signed in
 * nothing about who belongs where.
 */
export async function decideUpgrade(
  env: Env,
  accounts: AccountLookup,
  headers: { origin?: string; cookie?: string; authorization?: string },
  cohortId: string | undefined,
): Promise<UpgradeDecision> {
  const cookieToken = readSessionCookie(headers.cookie);

  if (headers.origin !== undefined) {
    if (!allowedOrigins(env).includes(headers.origin)) {
      return { ok: false, refusal: 'origin_not_allowed' };
    }
  } else if (cookieToken !== undefined) {
    return { ok: false, refusal: 'origin_not_allowed' };
  }

  const token = cookieToken ?? bearer(headers.authorization);
  if (!token) {
    return { ok: false, refusal: 'no_token' };
  }

  let claims: SessionClaims;
  try {
    claims = await verifySessionToken(token, env.AUTH_SESSION_SECRET);
  } catch (err) {
    if (err instanceof InvalidSessionTokenError) {
      return { ok: false, refusal: 'token_not_usable' };
    }
    throw err;
  }

  if (claims.scope !== SessionScope.FullAccess) {
    return { ok: false, refusal: 'wrong_scope' };
  }

  const account = await accounts.find(claims.userId);
  if (!account) {
    return { ok: false, refusal: 'account_gone', userId: claims.userId };
  }
  if (account.suspended) {
    return { ok: false, refusal: 'account_suspended', userId: claims.userId };
  }

  // An access token outlives a sign-out by up to its fifteen minutes. The
  // login behind it has to be live too, or a token lifted from a browser
  // that has since signed out would still open the campus.
  if (claims.sessionId !== undefined) {
    const now = new Date();
    const live = await accounts.liveSessions(
      [claims.sessionId],
      sessionRefreshedSince(env, now),
      now,
    );
    if (!live.has(claims.sessionId)) {
      return { ok: false, refusal: 'session_ended' };
    }
  }

  // No default: somebody may belong to several, and guessing would put them
  // somewhere they did not ask to be.
  if (cohortId === undefined || cohortId === '') {
    return { ok: false, refusal: 'no_cohort' };
  }

  // Without this a Backend student enters the Frontend floor by editing a
  // query string.
  if (!(await accounts.liveMembership(claims.userId, cohortId, new Date()))) {
    return { ok: false, refusal: 'not_a_member' };
  }

  return { ok: true, claims, cohortId };
}

/** The oldest refresh that still counts as campus-api vouching for a login. */
export function sessionRefreshedSince(env: Env, now: Date): Date {
  return new Date(
    now.getTime() - env.WORLD_SESSION_REFRESH_WINDOW_SECONDS * 1000,
  );
}
