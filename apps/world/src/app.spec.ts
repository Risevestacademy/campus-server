import { SessionScope, signSessionToken } from '@campus/session';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';

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

/**
 * The real Redis client, pointed at a port nothing listens on. Redis being
 * down must cost somebody their saved position, never their way in: with
 * commands failing fast instead of queueing, a join starts at the spawn at
 * once rather than waiting for Redis to come back.
 */
describe('with Redis unreachable', () => {
  it('still lets somebody in, at the spawn, without waiting', async () => {
    const secret = 'a-world-session-secret-of-at-least-32-chars';
    const unreachable = loadEnv({
      AUTH_SESSION_SECRET: secret,
      DATABASE_URL: 'postgres://unused',
      REDIS_URL: 'redis://127.0.0.1:1',
      CORS_ORIGINS: 'https://campus.example.com',
      FF_LOG_LEVEL: 'fatal',
    } as NodeJS.ProcessEnv);
    const world = await buildWorld(unreachable, {
      ...accounts,
      find: async (id: string) => ({ id, suspended: false }),
    });
    await world.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = world.app.server.address() as AddressInfo;
    const { token } = await signSessionToken(
      { userId: 'ada', email: 'ada@campus.local', scope: SessionScope.FullAccess },
      { secret, ttlMinutes: 30 },
    );

    const started = Date.now();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket`, {
      headers: { origin: 'https://campus.example.com', cookie: `campus_session=${token}` },
    });
    const snapshot = await new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.type === 'snapshot') resolve(message);
      });
    });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(snapshot.players).toEqual([{ userId: 'ada', x: 20, y: 15, facing: 'down' }]);

    const closed = new Promise((resolve) => ws.on('close', resolve));
    await world.gateway.stop();
    await closed;
    await world.app.close();
    await world.positions.close();
  });
});
