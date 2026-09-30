import { ApiProperty } from '@nestjs/swagger';

/**
 * When to come back. The tokens themselves travel in Set-Cookie and never in
 * the body; these are only the deadlines, so the web app can schedule the
 * next refresh instead of guessing at the lifetime.
 */
export class RefreshResponseDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-30T12:15:00.000Z',
    description:
      'When the new access token lapses. Refresh a little before this. It ' +
      'can be sooner than AUTH_SESSION_TTL_MINUTES: a guest whose visit ' +
      'ends first gets a token that ends with it.',
  })
  expiresAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-10-30T12:00:00.000Z',
    description:
      'When the new refresh token lapses. Past this, the user signs in again.',
  })
  refreshExpiresAt: Date;
}
