import { CallHandler, ExecutionContext, HttpStatus, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import type { PostHog } from 'posthog-node';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { resolveExceptionStatus } from '../../shared/exceptions/resolve-status.js';

const DISTINCT_ID_HEADER = 'x-posthog-distinct-id';
const MIN_STATUS_TO_CAPTURE = HttpStatus.INTERNAL_SERVER_ERROR;

function resolveClientIp(request: Request): string | undefined {
  const forwarded = request.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const ip = first?.split(',')[0]?.trim();
  return ip || request.socket?.remoteAddress;
}

function sanitizeDistinctId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  // oxlint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
  return cleaned ? cleaned.slice(0, 1000) : undefined;
}

export class PostHogExceptionInterceptor implements NestInterceptor {
  constructor(private readonly posthog: PostHog) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((exception: unknown) => {
        const status = resolveExceptionStatus(exception);
        if (status >= MIN_STATUS_TO_CAPTURE) {
          const request = context.switchToHttp().getRequest<Request>();
          const distinctId = sanitizeDistinctId(request.headers[DISTINCT_ID_HEADER]);
          try {
            this.posthog.captureException(exception, distinctId, {
              method: request.method,
              path: request.path,
              status_code: status,
              $ip: resolveClientIp(request),
              $user_agent: request.headers['user-agent'],
            });
          } catch (error) {
            console.error('Failed to capture exception in PostHog', error);
          }
        }
        return throwError(() => exception);
      }),
    );
  }
}
