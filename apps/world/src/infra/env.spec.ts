import { describe, expect, it } from 'vitest';

import { allowedOrigins, loadEnv, mediaCredentials } from './env.js';

const minimal = {
  AUTH_SESSION_SECRET: 'a-world-session-secret-of-at-least-32-chars',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/campus',
} as NodeJS.ProcessEnv;

describe('loadEnv', () => {
  it('refuses to start without a session secret, since nothing could sign in', () => {
    expect(() => loadEnv({} as NodeJS.ProcessEnv)).toThrow(
      /AUTH_SESSION_SECRET/,
    );
  });

  it('refuses a secret short enough to be guessed', () => {
    expect(() =>
      loadEnv({
        ...minimal,
        AUTH_SESSION_SECRET: 'too-short',
      } as NodeJS.ProcessEnv),
    ).toThrow(/AUTH_SESSION_SECRET/);
  });

  /** Without it, world cannot tell a suspended account from a welcome one. */
  it('refuses to start without a database to check accounts against', () => {
    expect(() =>
      loadEnv({
        AUTH_SESSION_SECRET: 'a-world-session-secret-of-at-least-32-chars',
      } as NodeJS.ProcessEnv),
    ).toThrow(/DATABASE_URL/);
  });

  it('defaults the port, log level and heartbeat', () => {
    const env = loadEnv(minimal);

    expect(env).toMatchObject({
      PORT: 3001,
      FF_LOG_LEVEL: 'info',
      FF_LOG_PRETTY: false,
      WORLD_HEARTBEAT_SECONDS: 30,
      WORLD_DB_POOL: 5,
    });
  });

  it('defaults the movement timings and limits', () => {
    expect(loadEnv(minimal)).toMatchObject({
      WORLD_STEP_MS: 100,
      WORLD_TICK_MS: 50,
      WORLD_RECONNECT_GRACE_SECONDS: 30,
      WORLD_SESSION_REFRESH_WINDOW_SECONDS: 1200,
      WORLD_MAX_MESSAGES_PER_SECOND: 20,
      WORLD_MAX_BUFFERED_BYTES: 1_048_576,
    });
  });

  /**
   * Shorter than one access token's life plus slack, and world would end
   * sessions that are being refreshed exactly on schedule.
   */
  it('refuses a session refresh window the shared session policy cannot meet', () => {
    expect(() =>
      loadEnv({
        ...minimal,
        WORLD_SESSION_REFRESH_WINDOW_SECONDS: '60',
      } as NodeJS.ProcessEnv),
    ).toThrow(/WORLD_SESSION_REFRESH_WINDOW_SECONDS.*at least 1020/);
    expect(() =>
      loadEnv({
        ...minimal,
        WORLD_SESSION_REFRESH_WINDOW_SECONDS: '900',
      } as NodeJS.ProcessEnv),
    ).toThrow(/WORLD_SESSION_REFRESH_WINDOW_SECONDS/);
    expect(
      loadEnv({
        ...minimal,
        WORLD_SESSION_REFRESH_WINDOW_SECONDS: '1020',
      } as NodeJS.ProcessEnv).WORLD_SESSION_REFRESH_WINDOW_SECONDS,
    ).toBe(1020);
  });

  /** Development may run without a published map; nothing else may. */
  it('needs somewhere to load the map from, outside development', () => {
    const development = loadEnv(minimal);
    expect(development.SANITY_PROJECT_ID).toBeUndefined();
    expect(development.SANITY_DATASET).toBe('production');
    expect(() =>
      loadEnv({
        ...minimal,
        DEPLOYMENT_ENVIRONMENT: 'staging',
      } as NodeJS.ProcessEnv),
    ).toThrow(/SANITY_PROJECT_ID/);
    // A blank line in a .env file is not a project.
    expect(() =>
      loadEnv({
        ...minimal,
        DEPLOYMENT_ENVIRONMENT: 'staging',
        SANITY_PROJECT_ID: '',
      } as NodeJS.ProcessEnv),
    ).toThrow(/SANITY_PROJECT_ID/);
    expect(
      loadEnv({
        ...minimal,
        DEPLOYMENT_ENVIRONMENT: 'staging',
        SANITY_PROJECT_ID: 'abc123',
      } as NodeJS.ProcessEnv),
    ).toMatchObject({ SANITY_PROJECT_ID: 'abc123' });
  });

  it('rejects a log level pino would not understand', () => {
    expect(() =>
      loadEnv({ ...minimal, FF_LOG_LEVEL: 'chatty' } as NodeJS.ProcessEnv),
    ).toThrow(/FF_LOG_LEVEL/);
  });

  it('reads the origin allowlist as a trimmed list', () => {
    const env = loadEnv({
      ...minimal,
      CORS_ORIGINS: ' https://campus.example.com , http://localhost:3000 ',
    } as NodeJS.ProcessEnv);

    expect(allowedOrigins(env)).toEqual([
      'https://campus.example.com',
      'http://localhost:3000',
    ]);
  });

  /** Unset means nothing browser-based can connect, which is the safe default. */
  it('yields no origins when the list is unset or empty', () => {
    expect(allowedOrigins(loadEnv(minimal))).toEqual([]);
    expect(
      allowedOrigins(
        loadEnv({ ...minimal, CORS_ORIGINS: ' , ' } as NodeJS.ProcessEnv),
      ),
    ).toEqual([]);
  });

  describe('media server', () => {
    const local = {
      LIVEKIT_URL: 'ws://localhost:7880',
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'local-dev-secret-not-for-production-use',
    };

    it('is off when none of it is set, or all of it is blank', () => {
      expect(mediaCredentials(loadEnv(minimal))).toBeUndefined();
      expect(
        mediaCredentials(
          loadEnv({
            ...minimal,
            LIVEKIT_URL: '',
            LIVEKIT_API_KEY: ' ',
            LIVEKIT_API_SECRET: '',
          } as NodeJS.ProcessEnv),
        ),
      ).toBeUndefined();
    });

    it('reads all three together', () => {
      expect(
        mediaCredentials(
          loadEnv({ ...minimal, ...local } as NodeJS.ProcessEnv),
        ),
      ).toEqual({
        url: local.LIVEKIT_URL,
        apiKey: local.LIVEKIT_API_KEY,
        apiSecret: local.LIVEKIT_API_SECRET,
      });
    });

    it('refuses some of it without the rest', () => {
      expect(() =>
        loadEnv({
          ...minimal,
          ...local,
          LIVEKIT_API_SECRET: '',
        } as NodeJS.ProcessEnv),
      ).toThrow(/all of LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET/);
    });

    // The media package's own rules, so a bad value stops the boot rather
    // than the first person who tries to join.
    it.each([
      ['a secret short enough to guess', { LIVEKIT_API_SECRET: 'short' }],
      ['a url that is not a socket', { LIVEKIT_URL: 'https://example.com' }],
    ])('refuses %s', (_, override) => {
      expect(() =>
        loadEnv({ ...minimal, ...local, ...override } as NodeJS.ProcessEnv),
      ).toThrow(/LIVEKIT_URL: media/);
    });

    it('defaults the connection-check budget', () => {
      expect(loadEnv(minimal).WORLD_CONNECTION_CHECKS_PER_MINUTE).toBe(5);
    });
  });
});
