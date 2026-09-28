import { SessionScope, verifySessionToken } from '@campus/session';

import type { User } from '../users/schema.js';
import { SessionIssuer } from './session-issuer.js';

const SECRET = 'a'.repeat(48);

const config = {
  FF_GOOGLE_AUTH_ENABLED: true,
  AUTH_SESSION_TTL_MINUTES: 720,
  AUTH_PROVISIONAL_TTL_MINUTES: 30,
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_CALLBACK_URL: 'http://localhost:3001/v1/auth/google/callback',
  AUTH_STATE_SECRET: 'b'.repeat(48),
  AUTH_SESSION_SECRET: SECRET,
} as never;

const user = { id: 'user-1', email: 'guest@campus.local' } as User;

/** Stands in for CohortMembersService: only the one lookup is used. */
const membersEnding = (endsAt: Date | null) =>
  ({ soonestAccessExpiry: async () => endsAt }) as never;

const minutesBetween = (a: Date, b: Date) =>
  (b.getTime() - a.getTime()) / 60_000;

describe('SessionIssuer', () => {
  // Relative to the real clock, not a fixed date: one of these verifies the
  // token it just minted, and jose checks exp against wall time — a
  // hard-coded hour turns green or red depending on when the suite runs.
  // Whole seconds: signSessionToken floors exp to the second, so a `now`
  // carrying milliseconds makes every lifetime a fraction short.
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);

  it('mints the configured lifetime when nothing ends sooner', async () => {
    const issuer = new SessionIssuer(config, membersEnding(null));

    const session = await issuer.issueFullAccess(user, now);

    expect(minutesBetween(now, session.expiresAt)).toBe(720);
  });

  /**
   * The hole this closes: SessionGuard re-reads the user row on every
   * request but not their memberships, so a visit that ended at 10:00 would
   * otherwise keep working until the token lapsed — up to
   * AUTH_SESSION_TTL_MINUTES later. Capping at mint time also covers world,
   * which only verifies the token and knows nothing about cohorts.
   */
  it('never outlives a guest visit that ends sooner', async () => {
    const endsAt = new Date(now.getTime() + 60 * 60_000);
    const issuer = new SessionIssuer(config, membersEnding(endsAt));

    const session = await issuer.issueFullAccess(user, now);

    expect(session.expiresAt).toEqual(endsAt);
    const claims = await verifySessionToken(session.token, SECRET);
    expect(claims.expiresAt).toEqual(endsAt);
  });

  it('ignores an end date beyond the configured lifetime', async () => {
    const issuer = new SessionIssuer(
      config,
      membersEnding(new Date(now.getTime() + 30 * 24 * 60 * 60_000)),
    );

    const session = await issuer.issueFullAccess(user, now);

    expect(minutesBetween(now, session.expiresAt)).toBe(720);
  });

  // A zero-length token would bounce the browser straight back to sign-in,
  // where the membership check belongs and will refuse them properly.
  it('floors the lifetime at a minute for a visit ending now', async () => {
    const issuer = new SessionIssuer(config, membersEnding(now));

    const session = await issuer.issueFullAccess(user, now);

    expect(minutesBetween(now, session.expiresAt)).toBe(1);
  });

  it('leaves a provisional session at its own shorter lifetime', async () => {
    const issuer = new SessionIssuer(config, membersEnding(null));

    const session = await issuer.issueProvisional(user, {
      id: 'invite-1',
    } as never);

    expect(session.scope).toBe(SessionScope.Provisional);
    expect(session.redirectPath).toBe('/onboarding');
  });
});
