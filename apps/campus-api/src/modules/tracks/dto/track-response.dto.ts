export class TrackResponseDto {
  /** @example 33333333-3333-4333-8333-333333333333 */
  id: string;

  /** @example "Software Engineering" */
  name: string;

  /** @example SE */
  code: string;

  /** @example "Backend and infra" */
  description: string | null;

  /** @example 2026-09-22T12:00:00.000Z */
  createdAt: Date;

  /** @example 2026-09-22T12:00:00.000Z */
  updatedAt: Date;
}
