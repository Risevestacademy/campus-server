import { loadEnv, parseCorsOrigins } from './env.js';

// APP_PUBLIC_URL is required, so every loadEnv call in these tests carries
// it via testEnv — the cases below exercise the other variables.
function testEnv(overrides: Record<string, unknown> = {}) {
  return loadEnv({
    APP_PUBLIC_URL: 'https://api.campus.example.com',
    ...overrides,
  });
}

describe('loadEnv PostHog validation', () => {
  it('throws when FF_POSTHOG_ENABLED is true but POSTHOG_PROJECT_TOKEN is missing', () => {
    expect(() => testEnv({ FF_POSTHOG_ENABLED: 'true' })).toThrow(
      /POSTHOG_PROJECT_TOKEN/,
    );
  });

  it('throws when POSTHOG_PROJECT_TOKEN is not prefixed with "phc_"', () => {
    expect(() =>
      testEnv({
        FF_POSTHOG_ENABLED: 'true',
        POSTHOG_PROJECT_TOKEN: 'sk-not-a-project-key',
      }),
    ).toThrow(/POSTHOG_PROJECT_TOKEN/);
  });

  it('throws when POSTHOG_HOST is not a valid HTTPS URL', () => {
    expect(() =>
      testEnv({
        FF_POSTHOG_ENABLED: 'true',
        POSTHOG_PROJECT_TOKEN: 'phc_valid123',
        POSTHOG_HOST: 'http://insecure.example.com',
      }),
    ).toThrow();
  });

  it('succeeds when disabled, regardless of key or host', () => {
    expect(() =>
      testEnv({
        FF_POSTHOG_ENABLED: 'false',
        POSTHOG_PROJECT_TOKEN: 'not-a-valid-key',
        POSTHOG_HOST: 'not-a-valid-url',
      }),
    ).not.toThrow();
  });

  it('succeeds when enabled with a well-formed key and HTTPS host', () => {
    const env = testEnv({
      FF_POSTHOG_ENABLED: 'true',
      POSTHOG_PROJECT_TOKEN: 'phc_valid123',
      POSTHOG_HOST: 'https://us.i.posthog.com',
    });

    expect(env.FF_POSTHOG_ENABLED).toBe(true);
    expect(env.POSTHOG_PROJECT_TOKEN).toBe('phc_valid123');
  });
});

describe('loadEnv DEFAULT_ADMIN_EMAIL validation', () => {
  // Only `db:seed` needs it, so the API must still boot without it; `db:seed`
  // is what fails loudly when it is missing.
  it('does not require DEFAULT_ADMIN_EMAIL, which only db:seed reads', () => {
    expect(() => testEnv({})).not.toThrow();
    expect(testEnv({}).DEFAULT_ADMIN_EMAIL).toBeUndefined();
  });

  it('throws when DEFAULT_ADMIN_EMAIL is not an email', () => {
    expect(() => testEnv({ DEFAULT_ADMIN_EMAIL: 'not-an-email' })).toThrow(
      /DEFAULT_ADMIN_EMAIL/,
    );
  });

  it('succeeds with a valid email', () => {
    const env = testEnv({ DEFAULT_ADMIN_EMAIL: 'admin@campus.local' });
    expect(env.DEFAULT_ADMIN_EMAIL).toEqual(['admin@campus.local']);
  });

  it('takes several, comma-separated, tidied the way USERS stores them', () => {
    const env = testEnv({
      DEFAULT_ADMIN_EMAIL:
        ' Ada@Campus.local , grace@campus.local,ada@campus.local ,',
    });
    expect(env.DEFAULT_ADMIN_EMAIL).toEqual([
      'ada@campus.local',
      'grace@campus.local',
    ]);
  });

  it('refuses the whole list when any address is not one', () => {
    expect(() =>
      testEnv({ DEFAULT_ADMIN_EMAIL: 'ada@campus.local, grace' }),
    ).toThrow(/DEFAULT_ADMIN_EMAIL must be one or more email addresses/);
  });

  it('reads an empty value as unset', () => {
    expect(
      testEnv({ DEFAULT_ADMIN_EMAIL: ' , ' }).DEFAULT_ADMIN_EMAIL,
    ).toBeUndefined();
  });
});

describe('loadEnv Google sign-in validation', () => {
  const CREDENTIALS = {
    GOOGLE_CLIENT_ID: '416818957033-example.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'a-web-client-secret',
    GOOGLE_CALLBACK_URL: 'http://localhost:3000/v1/auth/google/callback',
    AUTH_STATE_SECRET: 'a-state-secret-of-at-least-32-characters',
    AUTH_SESSION_SECRET: 'a-session-secret-of-at-least-32-characters',
  };

  it('leaves the API bootable with no Google configuration at all', () => {
    expect(() => testEnv({})).not.toThrow();
    expect(testEnv({}).FF_GOOGLE_AUTH_ENABLED).toBe(false);
  });

  it('ignores malformed credentials while the flag is off', () => {
    expect(() =>
      testEnv({ GOOGLE_CALLBACK_URL: 'not-a-url', AUTH_STATE_SECRET: 'short' }),
    ).not.toThrow();
  });

  it.each(Object.keys(CREDENTIALS))(
    'refuses to boot with the flag on and %s missing',
    (missing) => {
      const source: Record<string, unknown> = {
        FF_GOOGLE_AUTH_ENABLED: 'true',
        ...CREDENTIALS,
      };
      delete source[missing];

      expect(() => testEnv(source)).toThrow(new RegExp(missing));
    },
  );

  it('rejects a callback URL that is not one', () => {
    expect(() =>
      testEnv({
        FF_GOOGLE_AUTH_ENABLED: 'true',
        ...CREDENTIALS,
        GOOGLE_CALLBACK_URL: 'campus-web-staging.up.railway.app',
      }),
    ).toThrow(/GOOGLE_CALLBACK_URL/);
  });

  it('rejects a state secret short enough to be guessed', () => {
    expect(() =>
      testEnv({
        FF_GOOGLE_AUTH_ENABLED: 'true',
        ...CREDENTIALS,
        AUTH_STATE_SECRET: 'too-short',
      }),
    ).toThrow(/AUTH_STATE_SECRET must be at least 32 characters/);
  });

  it('accepts a complete configuration', () => {
    const env = testEnv({ FF_GOOGLE_AUTH_ENABLED: 'true', ...CREDENTIALS });

    expect(env.FF_GOOGLE_AUTH_ENABLED).toBe(true);
    expect(env.GOOGLE_CLIENT_ID).toBe(CREDENTIALS.GOOGLE_CLIENT_ID);
  });
});

describe('loadEnv AUTH_COOKIE_DOMAIN', () => {
  const ON_DOMAIN = {
    APP_PUBLIC_URL: 'https://campus.example.com',
    GOOGLE_CALLBACK_URL:
      'https://campus.example.com/api/v1/auth/google/callback',
  };

  it('is unset by default, leaving the session cookie host-only', () => {
    expect(testEnv({}).AUTH_COOKIE_DOMAIN).toBeUndefined();
  });

  it('accepts a parent domain covering both the app and the callback', () => {
    expect(
      testEnv({ ...ON_DOMAIN, AUTH_COOKIE_DOMAIN: 'campus.example.com' })
        .AUTH_COOKIE_DOMAIN,
    ).toBe('campus.example.com');
    expect(() =>
      testEnv({ ...ON_DOMAIN, AUTH_COOKIE_DOMAIN: 'example.com' }),
    ).not.toThrow();
  });

  // The browser would drop the cookie without a word, so boot says it instead.
  it('refuses a domain that does not cover the hosts setting the cookie', () => {
    expect(() =>
      testEnv({ ...ON_DOMAIN, AUTH_COOKIE_DOMAIN: 'other.example.com' }),
    ).toThrow(/does not cover campus\.example\.com/);
  });

  it('refuses anything that is not a bare domain', () => {
    for (const value of [
      'https://campus.example.com',
      'campus',
      '.campus.example.com',
    ]) {
      expect(() =>
        testEnv({ ...ON_DOMAIN, AUTH_COOKIE_DOMAIN: value }),
      ).toThrow(/AUTH_COOKIE_DOMAIN/);
    }
  });
});

describe('loadEnv HTTP settings', () => {
  it('defaults TRUST_PROXY_HOPS to one, for Railway', () => {
    expect(testEnv({}).TRUST_PROXY_HOPS).toBe(1);
  });

  it('accepts zero hops, meaning trust no proxy', () => {
    expect(testEnv({ TRUST_PROXY_HOPS: '0' }).TRUST_PROXY_HOPS).toBe(0);
  });

  it('rejects a hop count that is not a whole number or is negative', () => {
    expect(() => testEnv({ TRUST_PROXY_HOPS: 'yes' })).toThrow(
      /TRUST_PROXY_HOPS/,
    );
    expect(() => testEnv({ TRUST_PROXY_HOPS: '-1' })).toThrow(
      /TRUST_PROXY_HOPS/,
    );
  });

  it('leaves CORS unset by default', () => {
    expect(testEnv({}).CORS_ORIGINS).toBeUndefined();
  });
});

describe('loadEnv session lifetimes', () => {
  it('defaults access tokens to the shared policy cap of fifteen minutes', () => {
    expect(testEnv({}).AUTH_SESSION_TTL_MINUTES).toBe(15);
  });

  /** Longer, and world would end sessions that are being refreshed on time. */
  it('refuses an access-token lifetime above the shared cap', () => {
    expect(() => testEnv({ AUTH_SESSION_TTL_MINUTES: '16' })).toThrow(
      /AUTH_SESSION_TTL_MINUTES must be at most 15/,
    );
    expect(
      testEnv({ AUTH_SESSION_TTL_MINUTES: '5' }).AUTH_SESSION_TTL_MINUTES,
    ).toBe(5);
  });
});

describe('loadEnv APP_PUBLIC_URL validation', () => {
  it('fails boot when APP_PUBLIC_URL is missing — no silent fallback', () => {
    // Deliberately loadEnv, not testEnv: this is the one case asserting
    // the required field rejects an empty environment.
    expect(() => loadEnv({})).toThrow(/APP_PUBLIC_URL/);
  });

  it('rejects a malformed URL', () => {
    expect(() => testEnv({ APP_PUBLIC_URL: 'not-a-url' })).toThrow(
      /APP_PUBLIC_URL/,
    );
  });

  it('accepts localhost for local dev and real origins otherwise', () => {
    expect(
      testEnv({ APP_PUBLIC_URL: 'http://localhost:3000' }).APP_PUBLIC_URL,
    ).toBe('http://localhost:3000');
    expect(
      testEnv({ APP_PUBLIC_URL: 'https://api.campus.example.com' })
        .APP_PUBLIC_URL,
    ).toBe('https://api.campus.example.com');
  });
});

describe('parseCorsOrigins', () => {
  it('splits a comma-separated list and trims each origin', () => {
    expect(
      parseCorsOrigins(' https://campus.example.com , http://localhost:3000 '),
    ).toEqual(['https://campus.example.com', 'http://localhost:3000']);
  });

  it('yields nothing for unset or empty values, which disables CORS', () => {
    expect(parseCorsOrigins(undefined)).toEqual([]);
    expect(parseCorsOrigins('')).toEqual([]);
    expect(parseCorsOrigins('  ,  ')).toEqual([]);
  });
});

describe('loadEnv email (Resend)', () => {
  const ON = {
    FF_EMAIL_ENABLED: 'true',
    RESEND_API_KEY: 're_123456789',
    EMAIL_FROM: 'Campus by Rise <invites@campusbyrise.com>',
  };

  it('is off by default and needs nothing', () => {
    expect(testEnv({}).FF_EMAIL_ENABLED).toBe(false);
  });

  it('accepts a key and a from-address, bare or named', () => {
    expect(() => testEnv(ON)).not.toThrow();
    expect(() =>
      testEnv({ ...ON, EMAIL_FROM: 'invites@campusbyrise.com' }),
    ).not.toThrow();
  });

  it('requires the key and the from-address once switched on', () => {
    expect(() => testEnv({ ...ON, RESEND_API_KEY: undefined })).toThrow(
      /RESEND_API_KEY/,
    );
    expect(() => testEnv({ ...ON, EMAIL_FROM: undefined })).toThrow(
      /EMAIL_FROM/,
    );
  });

  it('refuses a key that is not a Resend key, and a from that is not an address', () => {
    expect(() => testEnv({ ...ON, RESEND_API_KEY: 'sk_live_x' })).toThrow(
      /RESEND_API_KEY must start with "re_"/,
    );
    expect(() => testEnv({ ...ON, EMAIL_FROM: 'Campus by Rise' })).toThrow(
      /EMAIL_FROM/,
    );
  });
});
