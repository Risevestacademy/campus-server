import { ExceptionCode } from './exception-code.enum.js';

export abstract class DomainException extends Error {
  abstract readonly code: ExceptionCode;
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}