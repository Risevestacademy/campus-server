/**
 * When to come back. For a browser the tokens themselves travel in Set-Cookie
 * and never in the body; these are only the deadlines, so the web app can
 * schedule the next refresh instead of guessing at the lifetime. A client
 * that sent its refresh token in the body gets the new pair back the same way.
 */
export class RefreshResponseDto {
  /**
   * When the new access token lapses. Refresh a little before this. It can be
   * sooner than AUTH_SESSION_TTL_MINUTES: a guest whose visit ends first gets a
   * token that ends with it.
   * @example 2026-09-30T12:15:00.000Z
   */
  expiresAt: Date;

  /**
   * When the new refresh token lapses. Past this, the user signs in again.
   * @example 2026-10-30T12:00:00.000Z
   */
  refreshExpiresAt: Date;

  /**
   * The new access token. Only when the refresh token came in the request body;
   * a cookie refresh answers in cookies.
   */
  accessToken?: string;

  /**
   * The new refresh token, replacing the one just spent. Only when the refresh
   * token came in the request body.
   */
  refreshToken?: string;
}
