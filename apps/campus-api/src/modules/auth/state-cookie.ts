import type { CookieOptions } from 'express';

export const STATE_COOKIE = 'campus_oauth_state';

/** Matches the routes under the global `v1` prefix, so it is sent nowhere else. */
export const STATE_COOKIE_PATH = '/v1/auth';

const MAX_AGE_MS = 10 * 60 * 1000;

export function stateCookieOptions(callbackUrl: string): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: callbackUrl.startsWith('https://'),
    path: STATE_COOKIE_PATH,
    maxAge: MAX_AGE_MS,
  };
}

export function readStateCookie(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() !== STATE_COOKIE) {
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
