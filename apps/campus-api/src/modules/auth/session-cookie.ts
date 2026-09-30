import type { CookieOptions } from 'express';
import type { Response } from 'express';

import type { IssuedSession } from './session-issuer.js';

export const SESSION_COOKIE = 'campus_session';
export const REFRESH_COOKIE = 'campus_refresh';

/**
 * Sent to every route, since the session is not specific to one — unlike the
 * OAuth state cookie, which stays on /v1/auth.
 */
export const SESSION_COOKIE_PATH = '/';
export const REFRESH_COOKIE_PATH = '/v1/auth';

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
  path: string = SESSION_COOKIE_PATH,
): CookieOptions {
  const secure = apiUrl.startsWith('https://');
  const crossSite = secure && site(apiUrl) !== site(appUrl);

  return {
    httpOnly: true,
    secure,
    sameSite: crossSite ? 'none' : 'lax',
    path,
    expires: expiresAt,
  };
}

export function setSessionCookies(
  res: Response,
  apiUrl: string,
  appUrl: string,
  session: IssuedSession,
): void {
  res.cookie(
    SESSION_COOKIE,
    session.token,
    sessionCookieOptions(apiUrl, appUrl, session.expiresAt),
  );
  if (session.scope === 'full_access') {
    res.cookie(
      REFRESH_COOKIE,
      session.refreshToken,
      sessionCookieOptions(
        apiUrl,
        appUrl,
        session.refreshExpiresAt,
        REFRESH_COOKIE_PATH,
      ),
    );
  }
}

export function clearSessionCookies(
  res: Response,
  apiUrl: string,
  appUrl: string,
): void {
  res.clearCookie(
    SESSION_COOKIE,
    sessionCookieOptions(apiUrl, appUrl, new Date(0)),
  );
  res.clearCookie(
    REFRESH_COOKIE,
    sessionCookieOptions(
      apiUrl,
      appUrl,
      new Date(0),
      REFRESH_COOKIE_PATH,
    ),
  );
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
  return readCookie(header, SESSION_COOKIE);
}

export function readRefreshCookie(
  header: string | undefined,
): string | undefined {
  return readCookie(header, REFRESH_COOKIE);
}

function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) {
    return undefined;
  }

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() !== name) {
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
