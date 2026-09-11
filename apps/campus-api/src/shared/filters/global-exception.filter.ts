import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';

import { ExceptionCode } from '../exceptions/exception-code.enum.js';
import { resolveExceptionStatus } from '../exceptions/resolve-status.js';
import type { ErrorResponse } from './error-response.js';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const status = resolveExceptionStatus(exception);
    const body: ErrorResponse = {
      error: {
        code: this.mapStatusToCode(status),
        message: this.resolveMessage(exception),
      },
    };

    response.status(status).json(body);
  }

  private resolveMessage(exception: unknown): string {
    if (exception instanceof HttpException) {
      if (exception.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
        return 'Too many requests, retry later.';
      }
      return exception.message;
    }
    if (exception instanceof Error && exception.message) {
      return exception.message;
    }
    return 'An unexpected error occurred';
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