import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';

import { ExceptionCode } from '../exceptions/exception-code.enum.js';
import { resolveExceptionStatus } from '../exceptions/resolve-status.js';
import type { ErrorResponse } from './error-response.js';

const GENERIC_MESSAGE = 'An unexpected error occurred';

/** Structural, so the filter works with nestjs-pino or a plain console. */
export interface ErrorLogger {
  error(payload: Record<string, unknown>, message: string): void;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger?: ErrorLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const status = resolveExceptionStatus(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logUnhandled(exception, ctx.getRequest<Request & { id?: string }>());
    }

    const body: ErrorResponse = {
      error: {
        code: this.mapStatusToCode(status),
        message: this.resolveMessage(exception, status),
      },
    };

    response.status(status).json(body);
  }

  private logUnhandled(
    exception: unknown,
    request?: Request & { id?: string },
  ): void {
    const payload: Record<string, unknown> = {
      err: exception,
      method: request?.method,
      url: request?.url,
    };
    if (request?.id) {
      payload.correlationId = request.id;
    }

    if (this.logger) {
      this.logger.error(payload, 'Unhandled exception');
      return;
    }
    console.error('Unhandled exception', payload);
  }

  /**
   * An HttpException carries a message somebody wrote for the caller. Any
   * other error carries whatever the runtime happened to produce — a failed
   * query with its SQL and bound parameters, a connection string with its
   * password — so only the generic message is safe to return.
   */
  private resolveMessage(exception: unknown, status: number): string {
    if (exception instanceof HttpException) {
      if (exception.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
        return 'Too many requests, retry later.';
      }
      return exception.message;
    }
    if (
      status < HttpStatus.INTERNAL_SERVER_ERROR &&
      exception instanceof Error
    ) {
      return exception.message;
    }
    return GENERIC_MESSAGE;
  }

  private mapStatusToCode(status: number): ExceptionCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ExceptionCode.InvalidArgument;
      case HttpStatus.UNAUTHORIZED:
        return ExceptionCode.Unauthorized;
      case HttpStatus.FORBIDDEN:
        return ExceptionCode.Forbidden;
      case HttpStatus.NOT_FOUND:
        return ExceptionCode.NotFound;
      case HttpStatus.CONFLICT:
        return ExceptionCode.Conflict;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ExceptionCode.RateLimited;
      default:
        return ExceptionCode.InternalError;
    }
  }
}
