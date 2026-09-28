import type { ArgumentsHost } from '@nestjs/common';

import { ExceptionCode } from '../exceptions/exception-code.enum.js';
import { DomainException } from '../exceptions/domain.exception.js';
import { DomainExceptionFilter } from './domain-exception.filter.js';

class TestException extends DomainException {
  readonly code: ExceptionCode;

  constructor(code: ExceptionCode, message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.code = code;
  }
}

describe('DomainExceptionFilter', () => {
  const run = (
    exception: DomainException,
    logger?: { error: ReturnType<typeof vi.fn> },
  ) => {
    const response = { statusCode: 0, body: undefined as unknown };
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({
          status: (code: number) => {
            response.statusCode = code;
            return {
              json: (body: unknown) => {
                response.body = body;
              },
            };
          },
        }),
        getRequest: () => ({ method: 'GET', url: '/probe', id: 'corr-1' }),
      }),
    } as unknown as ArgumentsHost;

    new DomainExceptionFilter(logger).catch(exception, host);
    return response;
  };

  it('passes message and details through on a 4xx', () => {
    const logger = { error: vi.fn() };
    const res = run(
      new TestException(ExceptionCode.NotFound, 'No invite matches', {
        inviteId: 'abc',
      }),
      logger,
    );

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: ExceptionCode.NotFound,
        message: 'No invite matches',
        details: { inviteId: 'abc' },
      },
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  /**
   * The case this filter previously got wrong. A DomainException carrying
   * INTERNAL_ERROR is caught here and never reaches GlobalExceptionFilter, so
   * the "5xx gets a generic message" rule did not apply to it: a 500 written
   * with addresses in its details returned them to the caller.
   */
  it('withholds message and details on a 5xx', () => {
    const logger = { error: vi.fn() };
    const res = run(
      new TestException(
        ExceptionCode.InternalError,
        'Session invite is not addressed to the signed-in account',
        { inviteEmail: 'owner@x.com', accountEmail: 'impostor@x.com' },
      ),
      logger,
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: {
        code: ExceptionCode.InternalError,
        message: 'An unexpected error occurred',
      },
    });
    const wire = JSON.stringify(res.body);
    expect(wire).not.toContain('owner@x.com');
    expect(wire).not.toContain('impostor@x.com');
  });

  /** Not leaking it to the client is worthless if it also vanishes from the logs. */
  it('logs the withheld diagnostic on a 5xx', () => {
    const logger = { error: vi.fn() };
    run(
      new TestException(ExceptionCode.InternalError, 'boom', { inviteId: 'abc' }),
      logger,
    );

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [payload, message] = logger.error.mock.calls[0];
    expect(message).toBe('Unhandled exception');
    expect(payload.method).toBe('GET');
    expect(payload.url).toBe('/probe');
    expect(payload.correlationId).toBe('corr-1');
    expect(payload.err.details).toEqual({ inviteId: 'abc' });
  });

  it('falls back to console when no logger is wired', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      run(new TestException(ExceptionCode.InternalError, 'boom'));
      expect(spy).toHaveBeenCalledWith(
        'Unhandled exception',
        expect.objectContaining({ method: 'GET' }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('logs nothing on a 4xx', () => {
    const logger = { error: vi.fn() };
    run(new TestException(ExceptionCode.Conflict, 'already accepted'), logger);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('tolerates a request without a correlation id', () => {
    const logger = { error: vi.fn() };
    const response = { statusCode: 0, body: undefined as unknown };
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({
          status: (code: number) => {
            response.statusCode = code;
            return { json: (b: unknown) => { response.body = b; } };
          },
        }),
        getRequest: () => ({}),
      }),
    } as unknown as ArgumentsHost;

    new DomainExceptionFilter(logger).catch(
      new TestException(ExceptionCode.InternalError, 'boom'),
      host,
    );

    expect(response.statusCode).toBe(500);
    const [payload] = logger.error.mock.calls[0];
    expect(payload.correlationId).toBeUndefined();
  });
});
