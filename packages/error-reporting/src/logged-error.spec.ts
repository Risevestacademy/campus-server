import { describe, expect, it, vi } from 'vitest';

import type { ErrorReporter } from './error-reporter.js';
import { reportLoggedError } from './logged-error.js';

const ERROR = 50;
const WARN = 40;
const FATAL = 60;

function fakeReporter() {
  return { report: vi.fn(), shutdown: vi.fn() } satisfies ErrorReporter;
}

describe('reportLoggedError', () => {
  it('reports an error line that carries an error', () => {
    const reporter = fakeReporter();
    const err = new Error('boom');

    reportLoggedError(reporter, ERROR, [
      {
        err,
        userId: 'user-1',
        correlationId: 'corr-1',
        method: 'POST',
        route: '/v1/invites/:id/revoke',
        statusCode: 500,
      },
      'Unhandled exception',
    ]);

    expect(reporter.report).toHaveBeenCalledWith(err, {
      distinctId: 'user-1',
      level: 'error',
      properties: {
        log_message: 'Unhandled exception',
        log_context: undefined,
        correlation_id: 'corr-1',
        method: 'POST',
        route: '/v1/invites/:id/revoke',
        status_code: 500,
        trace_id: undefined,
      },
    });
  });

  it('passes on only the named fields', () => {
    const reporter = fakeReporter();

    reportLoggedError(reporter, ERROR, [
      { err: new Error('boom'), email: 'ada@example.com', inviteId: 'i-1' },
      'could not send',
    ]);

    const [, context] = reporter.report.mock.calls[0];
    expect(JSON.stringify(context)).not.toContain('ada@example.com');
    expect(JSON.stringify(context)).not.toContain('i-1');
  });

  it('leaves out warnings and lines without an error', () => {
    const reporter = fakeReporter();

    reportLoggedError(reporter, WARN, [{ err: new Error('x') }, 'degraded']);
    reportLoggedError(reporter, ERROR, [{ inviteId: 'i-1' }, 'no error here']);
    reportLoggedError(reporter, ERROR, ['just a message']);

    expect(reporter.report).not.toHaveBeenCalled();
  });

  it('takes an error passed as the whole line', () => {
    const reporter = fakeReporter();
    const err = new Error('boom');

    reportLoggedError(reporter, FATAL, [err, 'failed to start']);

    expect(reporter.report).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ level: 'fatal', distinctId: undefined }),
    );
  });

  it('marks a line that asks for it as a warning', () => {
    const reporter = fakeReporter();

    reportLoggedError(reporter, ERROR, [
      { err: new Error('maps down'), severity: 'warning' },
      'Dependency unavailable',
    ]);

    expect(reporter.report).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ level: 'warning' }),
    );
  });

  it("keeps the context Nest's logger puts a trailing message in", () => {
    const reporter = fakeReporter();

    reportLoggedError(reporter, ERROR, [
      { err: new Error('boom'), context: 'Unhandled exception' },
    ]);

    expect(reporter.report).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        properties: expect.objectContaining({
          log_context: 'Unhandled exception',
        }),
      }),
    );
  });

  it('falls back to the correlation id the logger is bound to', () => {
    const reporter = fakeReporter();

    reportLoggedError(reporter, ERROR, [{ err: new Error('a') }], {
      reqId: 'from-fastify',
    });
    reportLoggedError(reporter, ERROR, [{ err: new Error('b') }], {
      req: { id: 'from-pino-http' },
    });

    expect(reporter.report.mock.calls.map(([, c]) => c.properties)).toEqual([
      expect.objectContaining({ correlation_id: 'from-fastify' }),
      expect.objectContaining({ correlation_id: 'from-pino-http' }),
    ]);
  });
});
