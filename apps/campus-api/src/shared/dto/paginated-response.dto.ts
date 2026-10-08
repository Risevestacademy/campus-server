import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, ApiProperty } from '@nestjs/swagger';

export class PaginationMetaDto {
  @ApiProperty({ description: 'Current page number (1-based).', example: 1 })
  page: number;

  @ApiProperty({ description: 'Number of items per page.', example: 20 })
  perPage: number;

  @ApiProperty({
    description: 'Total number of items across all pages.',
    example: 152,
  })
  total: number;

  @ApiProperty({ description: 'Total number of pages.', example: 8 })
  totalPages: number;
}

/**
 * A page of anything, as the services return it.
 *
 * This is the TypeScript shape only. It is deliberately not what the OpenAPI
 * document describes: a generator cannot see `T`, so documented directly it
 * would say `items` holds strings. Each route documents its own page through
 * ApiPaginatedResponse below.
 */
export class PaginatedResponseDto<T> {
  items: T[];
  meta: PaginationMetaDto;
}

type ItemType = abstract new () => unknown;

const pageSchemas = new Map<ItemType, new () => unknown>();

/**
 * The page of one kind of item, as a schema of its own: `items` typed as
 * that item, beside `meta`. Named after the item (`PaginatedTrackResponseDto`)
 * so a generated client gets a real, named type for every list.
 *
 * One class per item type, made once: two routes listing the same thing
 * share a schema rather than registering the name twice.
 */
function pageSchemaFor(itemType: ItemType): new () => unknown {
  const existing = pageSchemas.get(itemType);
  if (existing) {
    return existing;
  }

  class PaginatedPage {
    @ApiProperty({
      description: 'The page of items.',
      type: () => [itemType],
    })
    items: unknown[];

    @ApiProperty({
      description: 'Pagination metadata.',
      type: PaginationMetaDto,
    })
    meta: PaginationMetaDto;
  }
  Object.defineProperty(PaginatedPage, 'name', {
    value: `Paginated${itemType.name}`,
  });

  pageSchemas.set(itemType, PaginatedPage);
  return PaginatedPage;
}

/**
 * Documents a route returning `PaginatedResponseDto<T>` as a page of that
 * item, with `items` typed directly.
 *
 * Not an `allOf` of a generic envelope and the typed array, which is how
 * this used to be written: the envelope has to say something about `items`,
 * and a client generated from the pair gets the two intersected — an array
 * of strings that is also an array of the item, which nothing can be.
 *
 * ```ts
 * @Get()
 * @ApiPaginatedResponse(CohortDto)
 * findMany(): Promise<PaginatedResponseDto<CohortDto>> { ... }
 * ```
 */
export function ApiPaginatedResponse<T extends ItemType>(
  itemType: T,
): MethodDecorator {
  const page = pageSchemaFor(itemType);
  return applyDecorators(
    ApiExtraModels(page, itemType),
    ApiOkResponse({ description: 'Paginated list.', type: page }),
  );
}
