import { SessionScope, verifySessionToken } from '@campus/session';

import type { AccessGrant } from '../cohorts/cohort-members.service.js';
import type { User } from '../users/schema.js';
import { SessionUnauthorizedError } from './auth.exceptions.js';
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
const unbounded: AccessGrant = { endsAt: null };

const minutesBetween = (a: Date, b: Date) =>
  (b.getTime() - a.getTime()) / 60_000;

describe('SessionIssuer', () => {
  // Whole seconds: signSessionToken floors exp to the second, so a `now`
  // carrying milliseconds makes every lifetime a fraction short. Relative to
  // the real clock, because one of these verifies the token it just minted
  // and jose checks exp against wall time.
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const issuer = new SessionIssuer(config);
  const at = (ms: number) => new Date(now.getTime() + ms);

  it('mints the configured lifetime when the grant has no deadline', async () => {
    const session = await issuer.issueFullAccess(user, unbounded, now);

    expect(minutesBetween(now, session.expiresAt)).toBe(720);
  });

  /**
   * The hole this closes: SessionGuard re-reads the user row on every
   * request but not their memberships, so a visit that ended at 10:00 would
   * otherwise keep working until the token lapsed. Capping at mint time also
   * covers world, which only verifies the token.
   */
  it('never outlives a grant that ends sooner', async () => {
    const endsAt = at(60 * 60_000);

    const session = await issuer.issueFullAccess(user, { endsAt }, now);

    expect(session.expiresAt).toEqual(endsAt);
    const claims = await verifySessionToken(session.token, SECRET);
    expect(claims.expiresAt).toEqual(endsAt);
  });

  it('ignores a deadline beyond the configured lifetime', async () => {
    const session = await issuer.issueFullAccess(
      user,
      { endsAt: at(30 * 24 * 60 * 60_000) },
      now,
    );

    expect(minutesBetween(now, session.expiresAt)).toBe(720);
  });

  /**
   * Rounding a sub-minute remainder up to a minute hands back access past
   * the deadline, which is the one thing this cap exists to prevent. Thirty
   * seconds left means a thirty-second token.
   */
  it('gives a sub-minute remainder exactly, not a rounded-up minute', async () => {
    const endsAt = at(30_000);

    const session = await issuer.issueFullAccess(user, { endsAt }, now);

    expect(session.expiresAt).toEqual(endsAt);
    expect(minutesBetween(now, session.expiresAt)).toBe(0.5);
  });

  /**
   * The expiry-crossing race. The gate resolved the grant a moment ago and
   * it was live; by the time we mint, it is not. Refusing is the only honest
   * answer — the same request arriving now would be turned away at the gate.
   */
  it('refuses a grant that ended between the decision and the mint', async () => {
    await expect(
      issuer.issueFullAccess(user, { endsAt: at(-1) }, now),
    ).rejects.toBeInstanceOf(SessionUnauthorizedError);
  });

  it('refuses a grant ending on the very instant it is minted', async () => {
    await expect(
      issuer.issueFullAccess(user, { endsAt: now }, now),
    ).rejects.toBeInstanceOf(SessionUnauthorizedError);
  });

  it('leaves a provisional session at its own shorter lifetime', async () => {
    const session = await issuer.issueProvisional(user, {
      id: 'invite-1',
    } as never);

    expect(session.scope).toBe(SessionScope.Provisional);
    expect(session.redirectPath).toBe('/onboarding');
  });
});
