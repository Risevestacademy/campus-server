import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import { Response } from 'express';

import { ValidationException } from '../exceptions/validation.exception.js';
import { ExceptionCode } from '../exceptions/exception-code.enum.js';
import type { ErrorResponse } from './error-response.js';

type FieldErrors = Record<string, string>;

interface ValidationDetails extends Record<string, unknown> {
  fields: FieldErrors;
}

@Catch(ValidationException)
export class ValidationExceptionFilter implements ExceptionFilter {
  catch(exception: ValidationException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const fields = this.flattenFields(exception.errors);
    const body: ErrorResponse<ValidationDetails> = {
      error: {
        code: ExceptionCode.InvalidArgument,
        message: 'Request validation failed',
        details: { fields },
      },
    };

    response.status(HttpStatus.BAD_REQUEST).json(body);
  }

  private flattenFields(errors: ValidationError[]): FieldErrors {
    const fields: FieldErrors = {};
    for (const error of errors) {
      this.mapError('', error, fields);
    }
    return fields;
  }

  private mapError(prefix: string, error: ValidationError, fields: FieldErrors): void {
    const key = prefix ? `${prefix}.${error.property}` : error.property;
    const constraint = error.constraints ? Object.values(error.constraints)[0] : undefined;
    if (constraint) {
      fields[key] = constraint;
    }
    for (const child of error.children ?? []) {
      this.mapError(key, child, fields);
    }
  }
}