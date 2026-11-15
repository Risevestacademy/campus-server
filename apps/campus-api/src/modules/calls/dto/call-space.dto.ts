import { IsUUID } from 'class-validator';

export class CallSpaceParamDto {
  /** @example 11111111-1111-4111-8111-111111111111 */
  @IsUUID()
  cohortId: string;

  /** @example 33333333-3333-4333-8333-333333333333 */
  @IsUUID()
  spaceId: string;
}
