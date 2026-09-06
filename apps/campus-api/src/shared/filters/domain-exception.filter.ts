import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { Response } from 'express';

import { DomainException } from '../exceptions/domain.exception.js';
import { ExceptionCode } from '../exceptions/exception-code.enum.js';
import type { ErrorResponse } from './error-response.js';

@Catch(DomainException)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: DomainException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const status = this.mapCodeToStatus(exception.code);
    const body: ErrorResponse = {
      error: {
        code: exception.code,
        message: exception.message,
        ...(exception.details ? { details: exception.details } : {}),
      },
    };

    response.status(status).json(body);
  }

  protected mapCodeToStatus(code: ExceptionCode): number {
    switch (code) {
      case ExceptionCode.InvalidArgument:
        return 400;
      case ExceptionCode.Unauthorized:
        return 401;
      case ExceptionCode.Forbidden:
        return 403;
      case ExceptionCode.NotFound:
        return 404;
      case ExceptionCode.Conflict:
      case ExceptionCode.SpaceAtCapacity:
        return 409;
      case ExceptionCode.RateLimited:
        return 429;
      case ExceptionCode.InternalError:
      default:
        return 500;
    }
  }
}