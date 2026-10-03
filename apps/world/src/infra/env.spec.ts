import { describe, expect, it } from 'vitest';

import { allowedOrigins, loadEnv } from './env.js';

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

  it('defaults a placeholder map with its spawn inside it', () => {
    expect(loadEnv(minimal)).toMatchObject({
      WORLD_MAP_WIDTH: 40,
      WORLD_MAP_HEIGHT: 30,
      WORLD_SPAWN_X: 20,
      WORLD_SPAWN_Y: 15,
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

  /** A spawn off the map would drop every arrival where they cannot move. */
  it('refuses a spawn outside the map', () => {
    expect(() =>
      loadEnv({
        ...minimal,
        WORLD_MAP_WIDTH: '10',
        WORLD_SPAWN_X: '10',
      } as NodeJS.ProcessEnv),
    ).toThrow(/WORLD_SPAWN_X/);
    expect(() =>
      loadEnv({
        ...minimal,
        WORLD_MAP_HEIGHT: '10',
        WORLD_SPAWN_Y: '12',
      } as NodeJS.ProcessEnv),
    ).toThrow(/WORLD_SPAWN_Y/);
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
});
