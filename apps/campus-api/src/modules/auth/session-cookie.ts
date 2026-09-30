import type { CookieOptions } from 'express';
import type { Response } from 'express';

import type { Env } from '../../infra/config/config.module.js';
import { requireGoogleAuth } from './google-auth.settings.js';
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
 * app may be a different site, since browsers refuse None without Secure; on
 * http, where both sides are localhost anyway, Lax is both workable and
 * stricter.
 */
export function sessionCookieOptions(
  apiUrl: string,
  appUrl: string,
  expiresAt: Date,
  path: string = SESSION_COOKIE_PATH,
): CookieOptions {
  const secure = apiUrl.startsWith('https://');
  const crossSite = secure && !provablySameSite(apiUrl, appUrl);

  return {
    httpOnly: true,
    secure,
    sameSite: crossSite ? 'none' : 'lax',
    path,
    expires: expiresAt,
  };
}

/** Where the cookies are set from and for — everything but the values. */
export interface CookieSite {
  /** The API as the browser reaches it: GOOGLE_CALLBACK_URL. */
  apiUrl: string;
  appUrl: string;
  /** AUTH_COOKIE_DOMAIN, applied to the session cookie only. */
  sessionDomain?: string;
}

export function cookieSite(config: Env): CookieSite {
  return {
    apiUrl: requireGoogleAuth(config).callbackUrl,
    appUrl: config.APP_PUBLIC_URL,
    sessionDomain: config.AUTH_COOKIE_DOMAIN,
  };
}

/**
 * Only the access token is shared across subdomains, because `world` on its
 * own host has to read it. The refresh token stays host-only and path-scoped:
 * nothing but campus-api ever needs it, so nothing else is sent it.
 */
function sessionOptions(site: CookieSite, expiresAt: Date): CookieOptions {
  return {
    ...sessionCookieOptions(site.apiUrl, site.appUrl, expiresAt),
    ...(site.sessionDomain ? { domain: site.sessionDomain } : {}),
  };
}

export function setSessionCookies(
  res: Response,
  site: CookieSite,
  session: IssuedSession,
): void {
  res.cookie(SESSION_COOKIE, session.token, sessionOptions(site, session.expiresAt));
  if (session.scope === 'full_access') {
    res.cookie(
      REFRESH_COOKIE,
      session.refreshToken,
      sessionCookieOptions(
        site.apiUrl,
        site.appUrl,
        session.refreshExpiresAt,
        REFRESH_COOKIE_PATH,
      ),
    );
  }
}

export function clearSessionCookies(res: Response, site: CookieSite): void {
  const expired = new Date(0);
  res.clearCookie(SESSION_COOKIE, sessionOptions(site, expired));
  if (site.sessionDomain) {
    // A cookie is only cleared by one naming the same Domain. Set before
    // AUTH_COOKIE_DOMAIN was, a host-only copy would outlive sign-out and keep
    // the browser looking signed in, so both are cleared.
    res.clearCookie(
      SESSION_COOKIE,
      sessionCookieOptions(site.apiUrl, site.appUrl, expired),
    );
  }
  res.clearCookie(
    REFRESH_COOKIE,
    sessionCookieOptions(site.apiUrl, site.appUrl, expired, REFRESH_COOKIE_PATH),
  );
}

/**
 * Same host, or one host nested under the other (api.campus.dev under
 * campus.dev). Anything else counts as cross-site.
 *
 * Deliberately not "the last two labels match": hosting domains such as
 * up.railway.app are public suffixes, so two services under one are separate
 * sites, and a Lax cookie would never reach the API from the app's fetches.
 * Getting it wrong this way only costs Lax where Lax was possible; the Origin
 * check on unsafe methods still stands behind a None cookie.
 */
function provablySameSite(apiUrl: string, appUrl: string): boolean {
  let api: string;
  let app: string;
  try {
    api = new URL(apiUrl).hostname;
    app = new URL(appUrl).hostname;
  } catch {
    return false;
  }
  return api === app || api.endsWith(`.${app}`) || app.endsWith(`.${api}`);
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
