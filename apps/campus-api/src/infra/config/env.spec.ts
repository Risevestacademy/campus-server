import { loadEnv } from './env.js';

describe('loadEnv PostHog validation', () => {
  it('throws when FF_POSTHOG_ENABLED is true but POSTHOG_API_KEY is missing', () => {
    expect(() => loadEnv({ FF_POSTHOG_ENABLED: 'true' })).toThrow(
      /POSTHOG_API_KEY/,
    );
  });

  it('throws when POSTHOG_API_KEY is not prefixed with "phc_"', () => {
    expect(() =>
      loadEnv({
        FF_POSTHOG_ENABLED: 'true',
        POSTHOG_API_KEY: 'sk-not-a-project-key',
      }),
    ).toThrow(/POSTHOG_API_KEY/);
  });

  it('throws when POSTHOG_HOST is not a valid HTTPS URL', () => {
    expect(() =>
      loadEnv({
        FF_POSTHOG_ENABLED: 'true',
        POSTHOG_API_KEY: 'phc_valid123',
        POSTHOG_HOST: 'http://insecure.example.com',
      }),
    ).toThrow();
  });

  it('succeeds when disabled, regardless of key or host', () => {
    expect(() => loadEnv({ FF_POSTHOG_ENABLED: 'false' })).not.toThrow();
  });

  it('succeeds when enabled with a well-formed key and HTTPS host', () => {
    const env = loadEnv({
      FF_POSTHOG_ENABLED: 'true',
      POSTHOG_API_KEY: 'phc_valid123',
      POSTHOG_HOST: 'https://us.i.posthog.com',
    });

    expect(env.FF_POSTHOG_ENABLED).toBe(true);
    expect(env.POSTHOG_API_KEY).toBe('phc_valid123');
  });
});
