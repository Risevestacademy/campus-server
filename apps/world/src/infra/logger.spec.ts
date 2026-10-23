import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { serializeRequest, silenceRoutes } from './logger.js';

describe('serializeRequest', () => {
  it('logs the path and the route, never the query string', () => {
    expect(
      serializeRequest({
        id: 'corr-1',
        method: 'GET',
        url: '/socket?cohortId=c-1&token=secret',
        routeOptions: { url: '/socket' },
      }),
    ).toEqual({
      id: 'corr-1',
      method: 'GET',
      url: '/socket',
      route: '/socket',
    });
  });

  it('logs a path that has no query string as it is', () => {
    expect(
      serializeRequest({ id: 'corr-2', method: 'GET', url: '/health' }),
    ).toEqual({
      id: 'corr-2',
      method: 'GET',
      url: '/health',
      route: undefined,
    });
  });
});

describe('silenceRoutes', () => {
  it('silences the routes listed, and what is under them, and no others', async () => {
    const app = Fastify();
    silenceRoutes(app, ['/health']);
    const levels = new Map<string, string | undefined>();
    app.addHook('onRoute', (route) => {
      levels.set(route.url, route.logLevel);
    });

    app.get('/health', async () => 'ok');
    app.get('/health/deep', async () => 'ok');
    app.get('/schema.json', async () => '{}');
    await app.ready();

    expect(levels.get('/health')).toBe('silent');
    expect(levels.get('/health/deep')).toBe('silent');
    expect(levels.get('/schema.json')).not.toBe('silent');
    await app.close();
  });
});
