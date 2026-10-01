import { ApiProperty } from '@nestjs/swagger';
import { SessionScope } from '@campus/session';

import type { IssuedSession } from '../session-issuer.js';

/**
 * A session handed over in a response body, for a client with no cookie jar
 * to keep it in — a native app. A browser never receives this: its tokens
 * travel in httpOnly cookies so the page cannot read them.
 *
 * Every field is always present. The ones with no value are null rather
 * than left out, so they are required-and-nullable in the OpenAPI document:
 * a generated client must not model them as fields that may be missing.
 */
export class SessionTokensDto {
  @ApiProperty({
    enum: Object.values(SessionScope),
    enumName: 'SessionScope',
    description:
      '`full_access` belongs in the campus. `provisional` still has an ' +
      'invite to answer, and every route but onboarding refuses it.',
  })
  scope: SessionScope;

  @ApiProperty({
    description: 'Send as `Authorization: Bearer <accessToken>` on every call.',
  })
  accessToken: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-30T12:15:00.000Z',
    description: 'When the access token lapses. Refresh a little before this.',
  })
  expiresAt: Date;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Exchange at POST /v1/auth/refresh for a new pair. Works once: keep ' +
      'the one each refresh returns. Null for a provisional session, which ' +
      'cannot be refreshed.',
  })
  refreshToken: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-10-30T12:00:00.000Z',
    description:
      'When the refresh token lapses. Past this, the user signs in again. ' +
      'Null for a provisional session.',
  })
  refreshExpiresAt: Date | null;
}

export class TokenSignInResponseDto extends SessionTokensDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: '66666666-6666-4666-8666-666666666666',
    description:
      'The invite to answer, if any: for a provisional session, the one it ' +
      'was issued for; for a full-access session, a pending invite to ' +
      'another cohort. Load it with GET /v1/invites/validate-user-invite.',
  })
  inviteId: string | null;
}

export function sessionTokens(session: IssuedSession): SessionTokensDto {
  return {
    scope: session.scope,
    accessToken: session.token,
    expiresAt: session.expiresAt,
    refreshToken: session.refreshToken ?? null,
    refreshExpiresAt: session.refreshExpiresAt ?? null,
  };
}
