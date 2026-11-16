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
  /** @example 1 */
  @ApiPropertyOptional({
    description: `Page to fetch, 1-based, up to ${MAX_PAGE}.`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page: number = 1;

  /**
   * Number of items per page.
   * @example 20
   */
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  perPage: number = 20;
}
