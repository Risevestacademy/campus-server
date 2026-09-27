import { describe, expect, it } from 'vitest';

import { allowedOrigins, loadEnv } from './env.js';

const minimal = {
  AUTH_SESSION_SECRET: 'a-world-session-secret-of-at-least-32-chars',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/campus',
} as NodeJS.ProcessEnv;

describe('loadEnv', () => {
  it('refuses to start without a session secret, since nothing could sign in', () => {
    expect(() => loadEnv({} as NodeJS.ProcessEnv)).toThrow(/AUTH_SESSION_SECRET/);
  });

  it('refuses a secret short enough to be guessed', () => {
    expect(() =>
      loadEnv({ ...minimal, AUTH_SESSION_SECRET: 'too-short' } as NodeJS.ProcessEnv),
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
      allowedOrigins(loadEnv({ ...minimal, CORS_ORIGINS: ' , ' } as NodeJS.ProcessEnv)),
    ).toEqual([]);
  });
});
