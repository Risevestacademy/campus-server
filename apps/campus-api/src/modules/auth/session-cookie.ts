import type { CookieOptions } from 'express';

export const SESSION_COOKIE = 'campus_session';

/**
 * Sent to every route, since the session is not specific to one — unlike the
 * OAuth state cookie, which stays on /v1/auth.
 */
export const SESSION_COOKIE_PATH = '/';

/**
 * httpOnly so script cannot read it, which is the point of putting the token
 * in a cookie rather than handing it to the page.
 *
 * On https the frontend is a different site from this API, so the cookie has
 * to be SameSite=None to travel on its requests at all — and browsers only
 * accept that with Secure. Over plain http (local dev, where both sides are
 * localhost and therefore same-site) that pairing is refused, so Lax is both
 * the workable and the stricter choice there.
 */
export function sessionCookieOptions(
  publicUrl: string,
  expiresAt: Date,
): CookieOptions {
  const crossSite = publicUrl.startsWith('https://');

  return {
    httpOnly: true,
    secure: crossSite,
    sameSite: crossSite ? 'none' : 'lax',
    path: SESSION_COOKIE_PATH,
    expires: expiresAt,
  };
}

export function readSessionCookie(
  header: string | undefined,
): string | undefined {
  if (!header) {
    return undefined;
  }

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) {
      continue;
    }
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }

  return undefined;
}
