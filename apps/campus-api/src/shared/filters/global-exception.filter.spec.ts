import {
  BadRequestException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';

import { GlobalExceptionFilter } from './global-exception.filter.js';

function run(exception: unknown, logger?: { error: ReturnType<typeof vi.fn> }) {
  const captured: { status?: number; body?: any } = {};
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({
        status(code: number) {
          captured.status = code;
          return this;
        },
        json(body: unknown) {
          captured.body = body;
          return this;
        },
      }),
      getRequest: () => ({ id: 'corr-1', method: 'GET', url: '/v1/thing' }),
    }),
  };

  new GlobalExceptionFilter(logger).catch(exception, host as never);
  return captured;
}

describe('GlobalExceptionFilter', () => {
  it('never returns the message of an unhandled error', () => {
    // Shaped like a drizzle failure: the SQL and the bound values are in the
    // message, and one of those values is somebody's email address.
    const dbError = new Error(
      'Failed query: select "email" from "users" where "email" = $1\nparams: victim@school.edu',
    );

    const { status, body } = run(dbError);

    expect(status).toBe(500);
    expect(body.error.message).toBe('An unexpected error occurred');
    expect(JSON.stringify(body)).not.toContain('victim@school.edu');
    expect(JSON.stringify(body)).not.toContain('select');
  });

  it('logs what it refuses to return, with the correlation id', () => {
    const logger = { error: vi.fn() };
    const boom = new Error('connect ECONNREFUSED postgres://user:pw@10.0.0.5');

    run(boom, logger);

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [payload, message] = logger.error.mock.calls[0];
    expect(message).toBe('Unhandled exception');
    expect(payload).toMatchObject({ err: boom, correlationId: 'corr-1' });
  });

  it('keeps the message of an HttpException, which was written for the caller', () => {
    const { status, body } = run(new NotFoundException('Cohort not found'));

    expect(status).toBe(404);
    expect(body.error).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Cohort not found',
    });
  });

  it('does not log client errors', () => {
    const logger = { error: vi.fn() };

    run(new BadRequestException('bad input'), logger);

    expect(logger.error).not.toHaveBeenCalled();
  });

  it('still rewrites the throttler message', () => {
    const { status, body } = run(
      new HttpException('ThrottlerException: Too Many Requests', 429),
    );

    expect(status).toBe(429);
    expect(body.error).toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Too many requests, retry later.',
    });
  });
});
