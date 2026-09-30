import { describe, expect, it } from 'vitest';

import { buildWorld } from './app.js';
import { loadEnv } from './infra/env.js';

const env = loadEnv({
  AUTH_SESSION_SECRET: 'a-world-session-secret-of-at-least-32-chars',
  DATABASE_URL: 'postgres://unused',
  FF_LOG_LEVEL: 'fatal',
} as NodeJS.ProcessEnv);

/** No database needed: these tests never open a socket. */
const accounts = {
  find: async () => null,
  liveSessions: async () => new Set<string>(),
  close: async () => undefined,
};

describe('the HTTP surface', () => {
  it('reports health, including how many sockets it is holding', async () => {
    const { app, gateway } = await buildWorld(env, accounts);

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      sockets: { connections: 0, users: 0 },
    });
    await gateway.stop();
    await app.close();
  });

  it('answers an unknown route in the shared error shape', async () => {
    const { app, gateway } = await buildWorld(env, accounts);

    const response = await app.inject({ method: 'GET', url: '/nowhere' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'No such route' },
    });
    await gateway.stop();
    await app.close();
  });

  it('echoes the correlation id it was given', async () => {
    const { app, gateway } = await buildWorld(env, accounts);

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': 'from-the-api' },
    });

    expect(response.headers['x-correlation-id']).toBe('from-the-api');
    await gateway.stop();
    await app.close();
  });
});
