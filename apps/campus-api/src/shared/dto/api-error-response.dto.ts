import { ApiProperty } from '@nestjs/swagger';

import { ExceptionCode } from '../exceptions/exception-code.enum.js';

export class ApiErrorDetailsDto {
  /** @example {"field":"value"} */
  details?: Record<string, unknown>;
}

export class ApiErrorBodyDto {
  /** Machine-readable error code. Always one of the ExceptionCode enum. */
  @ApiProperty({
    enum: ExceptionCode,
    enumName: 'ExceptionCode',
    example: ExceptionCode.NotFound,
  })
  code: ExceptionCode;

  /**
   * Human-readable description of the error.
   * @example "Resource not found"
   */
  message: string;

  /** Optional structured context about the error (e.g. offending field). */
  details?: Record<string, unknown>;
}

export class ApiErrorResponseDto {
  /** The error envelope. */
  error: ApiErrorBodyDto;
}
