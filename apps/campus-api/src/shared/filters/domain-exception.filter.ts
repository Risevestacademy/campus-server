import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { Request, Response } from 'express';

import { DomainException } from '../exceptions/domain.exception.js';
import { ExceptionCode, mapExceptionCodeToStatus } from '../exceptions/exception-code.enum.js';
import type { ErrorResponse } from './error-response.js';
import type { ErrorLogger } from './global-exception.filter.js';

const GENERIC_MESSAGE = 'An unexpected error occurred';

@Catch(DomainException)
export class DomainExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger?: ErrorLogger) {}

  catch(exception: DomainException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const status = this.mapCodeToStatus(exception.code);
    // A 5xx here is a bug in this service, not something the caller did. Its
    // message and details are written for whoever reads the logs, and can
    // carry addresses, ids or query fragments — so nothing but the generic
    // message goes out. This is the same rule GlobalExceptionFilter applies
    // to non-domain exceptions; without it here, a DomainException carrying
    // INTERNAL_ERROR would bypass the one guarantee that rule exists to make.
    const serverFault = status >= 500;
    const body: ErrorResponse = {
      error: {
        code: exception.code,
        message: serverFault ? GENERIC_MESSAGE : exception.message,
        ...(!serverFault && exception.details
          ? { details: exception.details }
          : {}),
      },
    };

    // Swallowing the detail without recording it would trade a leak for an
    // invisible failure, so the diagnostic is logged instead of returned.
    if (serverFault) {
      this.log(exception, ctx.getRequest<Request & { id?: string }>());
    }

    response.status(status).json(body);
  }

  private log(
    exception: DomainException,
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

  protected mapCodeToStatus(code: ExceptionCode): number {
    return mapExceptionCodeToStatus(code);
  }
}