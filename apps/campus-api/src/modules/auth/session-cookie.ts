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
 * `secure` follows the API's own scheme, because that is the connection the
 * cookie is set over — deriving it from the web app's URL would drop the
 * cookie silently whenever the two differ. SameSite is None only when the
 * app is genuinely a different site, since browsers refuse None without
 * Secure; on http, where both sides are localhost anyway, Lax is both
 * workable and stricter.
 */
export function sessionCookieOptions(
  apiUrl: string,
  appUrl: string,
  expiresAt: Date,
): CookieOptions {
  const secure = apiUrl.startsWith('https://');
  const crossSite = secure && site(apiUrl) !== site(appUrl);

  return {
    httpOnly: true,
    secure,
    sameSite: crossSite ? 'none' : 'lax',
    path: SESSION_COOKIE_PATH,
    expires: expiresAt,
  };
}

/** Host without its leading label, which is close enough to a site here. */
function site(url: string): string {
  try {
    const { hostname } = new URL(url);
    return hostname.split('.').slice(-2).join('.');
  } catch {
    return url;
  }
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
