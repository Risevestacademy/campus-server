import { loadEnv } from './env.js';

describe('loadEnv PostHog validation', () => {
  it('throws when FF_POSTHOG_ENABLED is true but POSTHOG_PROJECT_TOKEN is missing', () => {
    expect(() => loadEnv({ FF_POSTHOG_ENABLED: 'true' })).toThrow(
      /POSTHOG_PROJECT_TOKEN/,
    );
  });

  it('throws when POSTHOG_PROJECT_TOKEN is not prefixed with "phc_"', () => {
    expect(() =>
      loadEnv({
        FF_POSTHOG_ENABLED: 'true',
        POSTHOG_PROJECT_TOKEN: 'sk-not-a-project-key',
      }),
    ).toThrow(/POSTHOG_PROJECT_TOKEN/);
  });

  it('throws when POSTHOG_HOST is not a valid HTTPS URL', () => {
    expect(() =>
      loadEnv({
        FF_POSTHOG_ENABLED: 'true',
        POSTHOG_PROJECT_TOKEN: 'phc_valid123',
        POSTHOG_HOST: 'http://insecure.example.com',
      }),
    ).toThrow();
  });

  it('succeeds when disabled, regardless of key or host', () => {
    expect(() =>
      loadEnv({
        FF_POSTHOG_ENABLED: 'false',
        POSTHOG_PROJECT_TOKEN: 'not-a-valid-key',
        POSTHOG_HOST: 'not-a-valid-url',
      }),
    ).not.toThrow();
  });

  it('succeeds when enabled with a well-formed key and HTTPS host', () => {
    const env = loadEnv({
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
    expect(() => loadEnv({})).not.toThrow();
    expect(loadEnv({}).DEFAULT_ADMIN_EMAIL).toBeUndefined();
  });

  it('throws when DEFAULT_ADMIN_EMAIL is not an email', () => {
    expect(() => loadEnv({ DEFAULT_ADMIN_EMAIL: 'not-an-email' })).toThrow(
      /DEFAULT_ADMIN_EMAIL/,
    );
  });

  it('succeeds with a valid email', () => {
    const env = loadEnv({ DEFAULT_ADMIN_EMAIL: 'admin@campus.local' });
    expect(env.DEFAULT_ADMIN_EMAIL).toBe('admin@campus.local');
  });
});
