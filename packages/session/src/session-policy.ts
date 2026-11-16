/**
 * The session lifetimes the services have to agree on, in one place.
 * campus-api mints access tokens and world keeps sockets open by following
 * the sign-in behind them; if the two drift apart, world ends sessions that
 * are being refreshed exactly as intended.
 */

/**
 * The longest an access token may live. campus-api refuses an
 * AUTH_SESSION_TTL_MINUTES above it, so a client refreshing once per token is
 * guaranteed to refresh at least this often.
 */
export const MAX_ACCESS_TOKEN_TTL_MINUTES = 15;

/**
 * Room for a refresh that lands a little late — a slow network, a laptop
 * waking from sleep — before world counts the sign-in as no longer refreshed.
 */
export const SESSION_REFRESH_SLACK_SECONDS = 120;

/**
 * The shortest refresh window world will accept: one full access-token
 * lifetime plus the slack. Anything shorter ends sessions that are being
 * refreshed on schedule.
 */
export const MIN_SESSION_REFRESH_WINDOW_SECONDS =
  MAX_ACCESS_TOKEN_TTL_MINUTES * 60 + SESSION_REFRESH_SLACK_SECONDS;

/** The two columns of a `refresh_tokens` row that decide whether it is live. */
export interface RefreshTokenLiveness {
  revokedAt: Date | null;
  expiresAt: Date;
}

/**
 * Not revoked, and expiring strictly after `now`: a token expiring at `now`
 * is already dead. campus-api asks this before a refresh; world cannot call
 * it from SQL, so LIVE_SESSIONS_QUERY spells out the same two clauses and
 * must stay in step with them.
 */
export function isRefreshTokenLive(
  token: RefreshTokenLiveness,
  now: Date,
): boolean {
  return token.revokedAt === null && token.expiresAt.getTime() > now.getTime();
}
