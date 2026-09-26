import {
  InvalidSessionTokenError,
  SessionScope,
  verifySessionToken,
  type SessionClaims,
} from '@campus/session';

import { allowedOrigins, type Env } from '../infra/env.js';

export type Refusal =
  | 'origin_not_allowed'
  | 'no_token'
  | 'token_not_usable'
  | 'wrong_scope';

export type UpgradeDecision =
  | { ok: true; claims: SessionClaims }
  | { ok: false; refusal: Refusal };

const SESSION_COOKIE = 'campus_session';

/** Same cookie campus-api sets; the browser sends it on the upgrade. */
export function readSessionCookie(header: string | undefined): string | undefined {
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
 */
export async function decideUpgrade(
  env: Env,
  headers: { origin?: string; cookie?: string; authorization?: string },
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

  return { ok: true, claims };
}
