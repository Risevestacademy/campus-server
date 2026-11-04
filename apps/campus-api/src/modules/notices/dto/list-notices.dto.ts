import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

import { PaginationQueryDto } from '../../../shared/dto/pagination-query.dto.js';
import { NoticeScope } from '../schema.js';

/**
 * Pagination plus the filters. Both filters only narrow the notices the
 * caller can already see; neither can widen that set.
 */
export class ListNoticesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: NoticeScope, enumName: 'NoticeScope' })
  @IsOptional()
  @IsEnum(NoticeScope)
  scope?: NoticeScope;

  /**
   * A cohort to narrow to. A cohort the caller is not in simply matches
   * nothing: the filter never reveals a notice outside their visibility.
   * @example 11111111-1111-4111-8111-111111111111
   */
  @IsOptional()
  @IsUUID()
  cohortId?: string;
}
