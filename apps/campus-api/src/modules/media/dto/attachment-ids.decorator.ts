import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';

import { IsOptionalNotNull } from '../../../shared/dto/optional-not-null.js';
import { MAX_ATTACHMENTS } from '../media-rules.js';

/** A list of uploads to attach, in order: at most MAX_ATTACHMENTS, no repeats, never null. */
export function AttachmentIds(): PropertyDecorator {
  return applyDecorators(
    ApiPropertyOptional({
      type: [String],
      format: 'uuid',
      maxItems: MAX_ATTACHMENTS,
    }),
    IsOptionalNotNull(),
    IsArray(),
    ArrayMaxSize(MAX_ATTACHMENTS),
    ArrayUnique(),
    IsUUID('all', { each: true }),
  );
}
