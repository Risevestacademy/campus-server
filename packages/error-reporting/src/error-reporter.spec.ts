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

  it('flushes on shutdown, giving up after 3 seconds', async () => {
    await createErrorReporter(options).shutdown();

    expect(shutdown).toHaveBeenCalledWith(3_000);
  });

  it('reports a failed query without the values it was given', () => {
    const reporter = createErrorReporter(options);
    const failed = Object.assign(
      new Error('invalid input syntax for type uuid: "ada@example.com"'),
      { name: 'PostgresError', code: '22P02', severity: 'ERROR' },
    );

    reporter.report(failed);

    const [sent] = captureException.mock.calls[0] as [Error];
    expect(sent.message).toBe('SQLSTATE 22P02');
    expect(JSON.stringify([sent.message, sent.stack])).not.toContain(
      'ada@example.com',
    );
  });

  it('scrubs an exception PostHog captured on its own', () => {
    createErrorReporter(options);

    const event = beforeSend()({
      event: '$exception',
      properties: {
        $exception_list: [
          { type: 'Error', value: 'Failed query: select $1\nparams: secret' },
        ],
      },
    }) as { properties: { $exception_list: { value: string }[] } };
    expect(event.properties.$exception_list[0].value).toBe(
      'Failed query: select $1',
    );
  });
});
