import { pino } from 'pino';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import type { ErrorReporter } from './error-reporter.js';
import { reportLoggedError, reportingHooks } from './logged-error.js';

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

describe('reportingHooks', () => {
  function logger() {
    return { bindings: vi.fn(() => ({ reqId: 'corr-1' })) };
  }

  it('reports an error line, tells the service, and still writes the line', () => {
    const reporter = fakeReporter();
    const alsoOnError = vi.fn();
    const method = { apply: vi.fn() };
    const line = [{ err: new Error('boom') }, 'could not'];
    const bound = logger();

    reportingHooks(reporter, alsoOnError).logMethod.call(
      bound,
      line,
      method,
      ERROR,
    );

    expect(reporter.report).toHaveBeenCalledTimes(1);
    expect(alsoOnError).toHaveBeenCalledWith(ERROR, line);
    expect(method.apply).toHaveBeenCalledWith(bound, line);
  });

  it('writes an error logged on its own scrubbed, since pino copies its message', () => {
    const reporter = fakeReporter();
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const log = pino({ hooks: reportingHooks(reporter) }, stream);
    const rejected = Object.assign(
      new Error('invalid input syntax for type uuid: "ada@example.com"'),
      { name: 'PostgresError', code: '22P02', severity: 'ERROR' },
    );

    log.error(rejected);
    log.warn(rejected);

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect((JSON.parse(line) as { msg: string }).msg).toBe('SQLSTATE 22P02');
    }
    expect(lines.join('')).not.toContain('ada@example.com');
    expect(reporter.report).toHaveBeenCalledWith(rejected, expect.anything());
  });

  it('writes other lines without building the bindings', () => {
    const reporter = fakeReporter();
    const method = { apply: vi.fn() };
    const bound = logger();

    reportingHooks(reporter).logMethod.call(
      bound,
      [{ userId: 'u-1' }, 'request completed'],
      method,
      30,
    );

    expect(bound.bindings).not.toHaveBeenCalled();
    expect(reporter.report).not.toHaveBeenCalled();
    expect(method.apply).toHaveBeenCalledTimes(1);
  });
});
