import { SessionScope, signSessionToken } from '@campus/session';
import { readFile } from 'node:fs/promises';
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
  liveMembership: async () => true,
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

  // What a client builds its types from. The committed file is the same
  // document, kept in step by the test beside protocol.schema.ts, so the two
  // can be compared byte for byte.
  it('serves the protocol it speaks, as the committed schema', async () => {
    const { app, gateway } = await buildWorld(env, accounts);

    const response = await app.inject({ method: 'GET', url: '/schema.json' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe(
      'application/json; charset=utf-8',
    );
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expect(response.body).toBe(
      await readFile(
        new URL('../protocol.schema.json', import.meta.url),
        'utf8',
      ),
    );
    expect(Object.keys(response.json().definitions)).toContain('ServerMessage');
    await gateway.stop();
    await app.close();
  });

  it('serves the protocol as AsyncAPI, addressed as the caller reached it', async () => {
    const { app, gateway } = await buildWorld(env, accounts);

    const response = await app.inject({
      method: 'GET',
      url: '/docs-json',
      headers: { host: 'ws.campus.example', 'x-forwarded-proto': 'https' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe(
      'application/json; charset=utf-8',
    );
    expect(response.json()).toMatchObject({
      asyncapi: '2.6.0',
      servers: { world: { url: 'ws.campus.example', protocol: 'wss' } },
    });

    const plain = await app.inject({
      method: 'GET',
      url: '/docs-json',
      headers: { host: 'localhost:3001' },
    });
    expect(plain.json().servers.world).toMatchObject({
      url: 'localhost:3001',
      protocol: 'ws',
    });
    await gateway.stop();
    await app.close();
  });

  // The page is a frame: the viewer comes from a CDN and reads the document
  // from this same instance, so all there is to check here is where it points.
  it('serves a docs page that shows the document this instance serves', async () => {
    const { app, gateway } = await buildWorld(env, accounts);

    const response = await app.inject({ method: 'GET', url: '/docs' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.body).toContain('url: "/docs-json"');
    expect(response.body).toMatch(
      /unpkg\.com\/@asyncapi\/react-component@\d+\.\d+\.\d+\/browser\/standalone\/index\.js/,
    );
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
 * A store that fails every call, standing in for Redis being down. Redis
 * being down must cost somebody their saved position, never their way in,
 * and must not hold up a shutdown.
 */
describe('with the position store failing', () => {
  const failing = {
    load: () => Promise.reject(new Error('redis is down')),
    save: () => Promise.reject(new Error('redis is down')),
    forget: () => Promise.reject(new Error('redis is down')),
    ready: async () => false,
    close: async () => undefined,
  };

  it('still lets somebody in, at the spawn, and still shuts down', async () => {
    const secret = 'a-world-session-secret-of-at-least-32-chars';
    const world = await buildWorld(
      loadEnv({
        AUTH_SESSION_SECRET: secret,
        DATABASE_URL: 'postgres://unused',
        CORS_ORIGINS: 'https://campus.example.com',
        FF_LOG_LEVEL: 'fatal',
      } as NodeJS.ProcessEnv),
      {
        ...accounts,
        find: async (id: string) => ({
          id,
          suspended: false,
          admin: false,
          sessionEpoch: 0,
        }),
      },
      failing,
    );
    await world.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = world.app.server.address() as AddressInfo;
    const { token } = await signSessionToken(
      {
        epoch: 0,
        userId: 'ada',
        email: 'ada@campus.local',
        scope: SessionScope.FullAccess,
      },
      { secret, ttlMinutes: 30 },
    );

    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket?cohortId=c-1`, {
      headers: {
        origin: 'https://campus.example.com',
        cookie: `campus_session=${token}`,
      },
    });
    const snapshot = await new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.type === 'snapshot') resolve(message);
      });
    });

    expect(snapshot.players).toEqual([
      { userId: 'ada', x: 20, y: 15, facing: 'down' },
    ]);

    const closed = new Promise((resolve) => ws.on('close', resolve));
    // The save on shutdown fails; stop() must still finish and close sockets.
    await world.gateway.stop();
    await closed;
    await world.app.close();
  });
});
