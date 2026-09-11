import { HttpException, HttpStatus } from '@nestjs/common';

import { DomainException } from './domain.exception.js';
import { mapExceptionCodeToStatus } from './exception-code.enum.js';

export function resolveExceptionStatus(exception: unknown): number {
  if (exception instanceof HttpException) {
    return exception.getStatus();
  }
  if (exception instanceof DomainException) {
    return mapExceptionCodeToStatus(exception.code);
  }
  return HttpStatus.INTERNAL_SERVER_ERROR;
}
