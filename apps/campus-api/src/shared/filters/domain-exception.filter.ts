import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { Request, Response } from 'express';

import { DomainException } from '../exceptions/domain.exception.js';
import {
  ExceptionCode,
  mapExceptionCodeToStatus,
} from '../exceptions/exception-code.enum.js';
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
    //
    // SERVICE_UNAVAILABLE is the one 5xx that is not a bug: something this
    // service depends on is not there, and it was raised on purpose to say
    // so. Its message is written for the caller, who needs it to know
    // whether to wait or to call somebody, so it goes out as written.
    const unavailable = exception.code === ExceptionCode.ServiceUnavailable;
    const serverFault = status >= 500 && !unavailable;
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
    // An unavailable dependency is logged too: it answers the caller, but
    // somebody still has to go and look at it.
    if (serverFault || unavailable) {
      this.log(
        exception,
        ctx.getRequest<Request & { id?: string }>(),
        unavailable ? 'Dependency unavailable' : 'Unhandled exception',
      );
    }

    response.status(status).json(body);
  }

  private log(
    exception: DomainException,
    request: (Request & { id?: string }) | undefined,
    message: string,
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
      this.logger.error(payload, message);
      return;
    }
    console.error(message, payload);
  }

  protected mapCodeToStatus(code: ExceptionCode): number {
    return mapExceptionCodeToStatus(code);
  }
}
