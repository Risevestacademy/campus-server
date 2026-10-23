import { describe, expect, it } from 'vitest';

import { serializeRequest } from './logger.js';

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
