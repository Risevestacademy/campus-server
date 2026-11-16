import { describe, expect, it, vi } from 'vitest';

import { fastifyOtelOptions } from './fastify-otel.js';

describe('fastifyOtelOptions', () => {
  it('keeps the query string off the request span', () => {
    const span = { setAttribute: vi.fn() };

    fastifyOtelOptions([]).requestHook(span as never, {
      url: '/schema.json?token=secret',
    });

    expect(span.setAttribute).toHaveBeenCalledWith('url.path', '/schema.json');
    expect(JSON.stringify(span.setAttribute.mock.calls)).not.toContain(
      'secret',
    );
  });

  it('leaves the quiet routes untraced', () => {
    const { ignorePaths } = fastifyOtelOptions(['/health']);

    expect(ignorePaths({ url: '/health' })).toBe(true);
    expect(ignorePaths({ url: '/schema.json' })).toBe(false);
  });
});
