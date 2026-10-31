import { IsUUID } from 'class-validator';

export class AttachTrackDto {
  /**
   * A track from GET /v1/tracks.
   * @example 33333333-3333-4333-8333-333333333333
   */
  @IsUUID()
  trackId: string;
}

/** The `:id` and `:trackId` of the route that detaches one track. */
export class CohortTrackParamDto {
  /** @example 11111111-1111-4111-8111-111111111111 */
  @IsUUID()
  id: string;

  /**
   * The track, as attached: the same id POST took as trackId.
   * @example 33333333-3333-4333-8333-333333333333
   */
  @IsUUID()
  trackId: string;
}

export class CohortIdParamDto {
  /** @example 11111111-1111-4111-8111-111111111111 */
  @IsUUID()
  id: string;
}
