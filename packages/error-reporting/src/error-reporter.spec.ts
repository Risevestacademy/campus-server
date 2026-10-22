import { PostHog } from 'posthog-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createErrorReporter } from './error-reporter.js';

const captureException = vi.fn();
const shutdown = vi.fn(async () => undefined);

vi.mock('posthog-node', () => ({
  PostHog: vi.fn(function () {
    return { captureException, shutdown };
  }),
}));

const options = {
  enabled: true,
  token: 'phc_test',
  host: 'https://eu.i.posthog.com',
  service: 'campus-api',
  environment: 'staging',
  release: 'abc123',
};

type BeforeSend = (event: unknown) => unknown;

function beforeSend(): BeforeSend {
  const [, config] = vi.mocked(PostHog).mock.calls[0] as unknown as [
    string,
    { before_send: BeforeSend },
  ];
  return config.before_send;
}

describe('createErrorReporter', () => {
  beforeEach(() => {
    vi.mocked(PostHog).mockClear();
    captureException.mockReset();
  });

  it('builds no client when switched off', async () => {
    const reporter = createErrorReporter({ ...options, enabled: false });
    reporter.report(new Error('boom'));
    await reporter.shutdown();

    expect(PostHog).not.toHaveBeenCalled();
  });

  it('builds no client without a token', () => {
    createErrorReporter({ ...options, token: undefined });

    expect(PostHog).not.toHaveBeenCalled();
  });

  it('captures uncaught exceptions and skips the geo lookup', () => {
    createErrorReporter(options);

    expect(PostHog).toHaveBeenCalledWith(
      'phc_test',
      expect.objectContaining({
        host: 'https://eu.i.posthog.com',
        disableGeoip: true,
        enableExceptionAutocapture: true,
      }),
    );
  });

  it('stamps service, environment and release on every event', () => {
    createErrorReporter(options);

    expect(
      beforeSend()({ event: '$exception', properties: { route: '/v1/x' } }),
    ).toEqual({
      event: '$exception',
      properties: {
        route: '/v1/x',
        service: 'campus-api',
        environment: 'staging',
        release: 'abc123',
      },
    });
    expect(beforeSend()(null)).toBeNull();
  });

  it('reports at error level unless told otherwise', () => {
    const reporter = createErrorReporter(options);
    const error = new Error('boom');

    reporter.report(error, {
      distinctId: 'user-1',
      properties: { route: '/r' },
    });
    reporter.report(error, { level: 'warning' });

    expect(captureException).toHaveBeenNthCalledWith(1, error, 'user-1', {
      route: '/r',
      $exception_level: 'error',
    });
    expect(captureException).toHaveBeenNthCalledWith(2, error, undefined, {
      $exception_level: 'warning',
    });
  });

  it('never throws when PostHog does', () => {
    captureException.mockImplementation(() => {
      throw new Error('PostHog down');
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() =>
        createErrorReporter(options).report(new Error('boom')),
      ).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it('flushes on shutdown', async () => {
    await createErrorReporter(options).shutdown();

    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
