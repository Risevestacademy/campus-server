import { BadRequestException } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

export class ValidationException extends BadRequestException {
  constructor(readonly errors: ValidationError[]) {
    super('Request validation failed');
  }
}