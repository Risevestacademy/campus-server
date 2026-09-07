import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ExceptionCode } from '../exceptions/exception-code.enum.js';

export class ApiErrorDetailsDto {
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { field: 'value' },
  })
  details?: Record<string, unknown>;
}

export class ApiErrorBodyDto {
  @ApiProperty({
    enum: ExceptionCode,
    enumName: 'ExceptionCode',
    example: ExceptionCode.NotFound,
    description: 'Machine-readable error code. Always one of the ExceptionCode enum.',
  })
  code: ExceptionCode;

  @ApiProperty({
    description: 'Human-readable description of the error.',
    example: 'Resource not found',
  })
  message: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Optional structured context about the error (e.g. offending field).',
  })
  details?: Record<string, unknown>;
}

export class ApiErrorResponseDto {
  @ApiProperty({ type: ApiErrorBodyDto, description: 'The error envelope.' })
  error: ApiErrorBodyDto;
}