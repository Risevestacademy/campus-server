import { ExceptionCode } from '../exceptions/exception-code.enum.js';

export interface ErrorResponse<TDetails extends Record<string, unknown> = Record<string, unknown>> {
  error: {
    code: ExceptionCode;
    message: string;
    details?: TDetails;
  };
}