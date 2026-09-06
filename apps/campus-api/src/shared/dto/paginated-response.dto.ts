import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, ApiProperty, getSchemaPath } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger';

export class PaginationMetaDto {
  @ApiProperty({ description: 'Current page number (1-based).', example: 1 })
  page: number;

  @ApiProperty({ description: 'Number of items per page.', example: 20 })
  perPage: number;

  @ApiProperty({ description: 'Total number of items across all pages.', example: 152 })
  total: number;

  @ApiProperty({ description: 'Total number of pages.', example: 8 })
  totalPages: number;
}

export class PaginatedResponseDto<T> {
  @ApiProperty({ description: 'The page of items.' })
  items: T[];

  @ApiProperty({ description: 'Pagination metadata.', type: PaginationMetaDto })
  meta: PaginationMetaDto;
}

/**
 * Documents a route returning `PaginatedResponseDto<T>` so the spec references
 * the concrete item schema via `getSchemaPath` instead of emitting `any[]`.
 *
 * The `itemType` is registered with `@ApiExtraModels` and referenced through a
 * composed `allOf` schema: the generic envelope + the typed `items` array.
 *
 * ```ts
 * @Get()
 * @ApiPaginatedResponse(CohortDto)
 * findMany(): Promise<PaginatedResponseDto<CohortDto>> { ... }
 * ```
 */
export function ApiPaginatedResponse<T extends abstract new () => unknown>(
  itemType: T,
): MethodDecorator {
  const schema: SchemaObject = {
    allOf: [
      { $ref: getSchemaPath(PaginatedResponseDto) },
      {
        properties: {
          items: {
            type: 'array',
            items: { $ref: getSchemaPath(itemType) },
          },
        },
      },
    ],
  };

  return applyDecorators(
    ApiExtraModels(PaginatedResponseDto, itemType),
    ApiOkResponse({ description: 'Paginated list.', schema }),
  );
}