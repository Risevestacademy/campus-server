import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { Response } from 'express';

import { DomainException } from '../exceptions/domain.exception.js';
import { ExceptionCode, mapExceptionCodeToStatus } from '../exceptions/exception-code.enum.js';
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
    return mapExceptionCodeToStatus(code);
  }
}