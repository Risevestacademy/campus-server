import type { Response } from 'express';

import {
  clearSessionCookies,
  REFRESH_COOKIE,
  SESSION_COOKIE,
  sessionCookieOptions,
  setSessionCookies,
  type CookieSite,
} from './session-cookie.js';
import type { FullAccessSession } from './session-issuer.js';

const expires = new Date('2026-01-01T00:00:00.000Z');

describe('sessionCookieOptions', () => {
  it('is Secure and cross-site when the app is a different site on https', () => {
    const options = sessionCookieOptions(
      'https://api.campus.example.com/v1/auth/google/callback',
      'https://app.other.example',
      expires,
    );

    expect(options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'none',
    });
  });

  it('stays Lax when the API sits under the app host', () => {
    const options = sessionCookieOptions(
      'https://api.campus.example.com/v1/auth/google/callback',
      'https://campus.example.com',
      expires,
    );

    expect(options).toMatchObject({ secure: true, sameSite: 'lax' });
  });

  it('stays Lax when the app proxies the API on its own host', () => {
    const options = sessionCookieOptions(
      'https://campus-web.up.railway.app/v1/auth/google/callback',
      'https://campus-web.up.railway.app',
      expires,
    );

    expect(options).toMatchObject({ secure: true, sameSite: 'lax' });
  });

  /**
   * up.railway.app is a public suffix: two services under it are two sites,
   * and a Lax cookie would never ride along on the app's fetches.
   */
  it('is cross-site for two services on a shared hosting domain', () => {
    const options = sessionCookieOptions(
      'https://campus-api.up.railway.app/v1/auth/google/callback',
      'https://campus-web.up.railway.app',
      expires,
    );

    expect(options).toMatchObject({ secure: true, sameSite: 'none' });
  });

  // Same site in fact, but that cannot be shown without a public-suffix
  // list. None still works there; it only gives up Lax.
  it('falls back to None for sibling subdomains', () => {
    const options = sessionCookieOptions(
      'https://api.campus.example.com/v1/auth/google/callback',
      'https://app.campus.example.com',
      expires,
    );

    expect(options).toMatchObject({ secure: true, sameSite: 'none' });
  });

  /**
   * Follows the API's own scheme: a cookie marked Secure over http is dropped
   * by the browser without a word, and the user is bounced back to sign-in.
   */
  it('is not Secure when the API itself is reached over http', () => {
    const options = sessionCookieOptions(
      'http://localhost:3000/v1/auth/google/callback',
      'https://app.campus.example.com',
      expires,
    );

    expect(options).toMatchObject({ secure: false, sameSite: 'lax' });
  });
});

describe('the shared session domain', () => {
  const site: CookieSite = {
    apiUrl: 'https://campus.example.com/api/v1/auth/google/callback',
    appUrl: 'https://campus.example.com',
    sessionDomain: 'campus.example.com',
  };
  const session: FullAccessSession = {
    scope: 'full_access',
    token: 'access',
    expiresAt: expires,
    refreshToken: 'refresh',
    refreshExpiresAt: expires,
    redirectPath: '/',
  };

  function recorder() {
    const calls: { kind: string; name: string; domain?: string }[] = [];
    const res = {
      cookie: (name: string, _v: string, o: { domain?: string }) =>
        calls.push({ kind: 'set', name, domain: o.domain }),
      clearCookie: (name: string, o: { domain?: string }) =>
        calls.push({ kind: 'clear', name, domain: o.domain }),
    } as unknown as Response;
    return { res, calls };
  }

  it('goes on the access cookie so world can read it, not the refresh one', () => {
    const { res, calls } = recorder();

    setSessionCookies(res, site, session);

    expect(calls).toEqual([
      { kind: 'set', name: SESSION_COOKIE, domain: 'campus.example.com' },
      { kind: 'set', name: REFRESH_COOKIE, domain: undefined },
    ]);
  });

  it('is left off entirely when unset', () => {
    const { res, calls } = recorder();

    setSessionCookies(res, { ...site, sessionDomain: undefined }, session);

    expect(calls.every((c) => c.domain === undefined)).toBe(true);
  });

  // A host-only copy set before the domain was configured is only cleared by
  // a Set-Cookie without Domain, and would otherwise outlive sign-out.
  it('clears both the shared and any host-only access cookie', () => {
    const { res, calls } = recorder();

    clearSessionCookies(res, site);

    expect(calls).toEqual([
      { kind: 'clear', name: SESSION_COOKIE, domain: 'campus.example.com' },
      { kind: 'clear', name: SESSION_COOKIE, domain: undefined },
      { kind: 'clear', name: REFRESH_COOKIE, domain: undefined },
    ]);
  });
});
