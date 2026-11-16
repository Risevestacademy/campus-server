import { captureLines } from '@campus/error-reporting/testing';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from './env.js';
import { loggerOptions, serializeRequest, silenceRoutes } from './logger.js';

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

describe('loggerOptions', () => {
  it('logs a failed query without the value Postgres rejected, however it is logged', async () => {
    const { stream, lines } = captureLines();
    const options = loggerOptions(
      { FF_LOG_LEVEL: 'info', FF_LOG_PRETTY: false } as Env,
      { report: vi.fn(), shutdown: vi.fn() },
    );
    const app = Fastify({ logger: { ...options, stream } });
    const rejected = Object.assign(
      new Error('invalid input syntax for type uuid: "ada@example.com"'),
      { name: 'PostgresError', code: '22P02', severity: 'ERROR' },
    );

    app.log.error({ err: rejected }, 'could not re-check account');
    app.log.error(rejected);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('SQLSTATE 22P02');
    expect(lines.join('')).not.toContain('ada@example.com');
    await app.close();
  });
});
