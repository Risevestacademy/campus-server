import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * The furthest page a list will fetch. Without a ceiling, a page number
 * like 1e30 still counts as a whole number here and reaches the database as
 * an offset too large for it, which answered 500. Ten thousand pages of a
 * hundred is a million rows in, past which a list is filtered, not paged.
 */
export const MAX_PAGE = 10_000;

export class PaginationQueryDto {
  @ApiPropertyOptional({
    description: `Page to fetch, 1-based, up to ${MAX_PAGE}.`,
    default: 1,
    example: 1,
    minimum: 1,
    maximum: MAX_PAGE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page: number = 1;

  @ApiPropertyOptional({
    description: 'Number of items per page.',
    default: 20,
    example: 20,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  perPage: number = 20;
}
