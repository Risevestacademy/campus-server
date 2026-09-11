import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import type { CallHandler } from '@nestjs/common';
import type { PostHog } from 'posthog-node';
import { firstValueFrom, throwError } from 'rxjs';

import { DomainException } from '../../shared/exceptions/domain.exception.js';
import { ExceptionCode } from '../../shared/exceptions/exception-code.enum.js';
import { PostHogExceptionInterceptor } from './posthog.interceptor.js';

class TestDomainException extends DomainException {
  constructor(readonly code: ExceptionCode) {
    super('test');
  }
}

function makeContext(headers: Record<string, string> = {}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'GET',
        path: '/reset-password',
        url: '/reset-password?token=super-secret',
        headers,
        socket: { remoteAddress: '127.0.0.1' },
      }),
    }),
  } as unknown as ExecutionContext;
}

function makeHandler(exception: unknown): CallHandler {
  return { handle: () => throwError(() => exception) };
}

async function run(posthog: PostHog, exception: unknown, headers?: Record<string, string>) {
  const interceptor = new PostHogExceptionInterceptor(posthog);
  await expect(firstValueFrom(interceptor.intercept(makeContext(headers), makeHandler(exception)))).rejects.toBe(
    exception,
  );
}

describe('PostHogExceptionInterceptor', () => {
  it('captures an HttpException with status >= 500', async () => {
    const posthog = { captureException: vi.fn() } as unknown as PostHog;
    await run(posthog, new HttpException('boom', HttpStatus.INTERNAL_SERVER_ERROR));
    expect(posthog.captureException).toHaveBeenCalledTimes(1);
  });

  it('does not capture an HttpException with status < 500', async () => {
    const posthog = { captureException: vi.fn() } as unknown as PostHog;
    await run(posthog, new HttpException('bad', HttpStatus.BAD_REQUEST));
    expect(posthog.captureException).not.toHaveBeenCalled();
  });

  it.each([
    [ExceptionCode.InvalidArgument, false],
    [ExceptionCode.Unauthorized, false],
    [ExceptionCode.Forbidden, false],
    [ExceptionCode.NotFound, false],
    [ExceptionCode.Conflict, false],
    [ExceptionCode.SpaceAtCapacity, false],
    [ExceptionCode.RateLimited, false],
    [ExceptionCode.InternalError, true],
  ])('DomainException with code %s is captured: %s', async (code, shouldCapture) => {
    const posthog = { captureException: vi.fn() } as unknown as PostHog;
    await run(posthog, new TestDomainException(code));
    expect(posthog.captureException).toHaveBeenCalledTimes(shouldCapture ? 1 : 0);
  });

  it('sends the request path without the query string even though the URL has one', async () => {
    const posthog = { captureException: vi.fn() } as unknown as PostHog;
    await run(posthog, new HttpException('boom', HttpStatus.INTERNAL_SERVER_ERROR));
    expect(posthog.captureException).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({ path: '/reset-password' }),
    );
    const properties = (posthog.captureException as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(JSON.stringify(properties)).not.toContain('super-secret');
  });

  it('sends $ip and $user_agent', async () => {
    const posthog = { captureException: vi.fn() } as unknown as PostHog;
    await run(posthog, new HttpException('boom', HttpStatus.INTERNAL_SERVER_ERROR), {
      'user-agent': 'test-agent',
      'x-forwarded-for': '203.0.113.5, 10.0.0.1',
    });
    expect(posthog.captureException).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({ $ip: '203.0.113.5', $user_agent: 'test-agent' }),
    );
  });

  it('falls back to the socket address when there is no x-forwarded-for header', async () => {
    const posthog = { captureException: vi.fn() } as unknown as PostHog;
    await run(posthog, new HttpException('boom', HttpStatus.INTERNAL_SERVER_ERROR));
    expect(posthog.captureException).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({ $ip: '127.0.0.1' }),
    );
  });

  it('uses the distinct-id header when present, leaving it undefined otherwise', async () => {
    const posthog = { captureException: vi.fn() } as unknown as PostHog;
    await run(posthog, new HttpException('boom', HttpStatus.INTERNAL_SERVER_ERROR), {
      'x-posthog-distinct-id': 'user-123',
    });
    expect(posthog.captureException).toHaveBeenCalledWith(expect.anything(), 'user-123', expect.anything());

    const posthogNoHeader = { captureException: vi.fn() } as unknown as PostHog;
    await run(posthogNoHeader, new HttpException('boom', HttpStatus.INTERNAL_SERVER_ERROR));
    expect(posthogNoHeader.captureException).toHaveBeenCalledWith(expect.anything(), undefined, expect.anything());
  });

  it('never throws when the PostHog client itself throws', async () => {
    const posthog = {
      captureException: vi.fn(() => {
        throw new Error('network error');
      }),
    } as unknown as PostHog;
    await run(posthog, new HttpException('boom', HttpStatus.INTERNAL_SERVER_ERROR));
  });
});
