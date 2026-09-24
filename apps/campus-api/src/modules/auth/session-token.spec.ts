import { SignJWT } from 'jose';

import {
  InvalidSessionTokenError,
  SessionScope,
  signSessionToken,
  verifySessionToken,
} from './session-token.js';

const SECRET = 'a-session-secret-of-at-least-32-characters';
const OTHER = 'a-completely-different-secret-of-32-chars!';
const settings = { secret: SECRET, ttlMinutes: 30 };

const claims = {
  userId: 'user-1',
  email: 'ada@campus.local',
  scope: SessionScope.FullAccess,
};

async function foreign(
  payload: Record<string, unknown>,
  overrides: { issuer?: string; audience?: string; secret?: string } = {},
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setIssuer(overrides.issuer ?? 'campus-api')
    .setAudience(overrides.audience ?? 'campus')
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(new TextEncoder().encode(overrides.secret ?? SECRET));
}

describe('session tokens', () => {
  it('round-trips the claims a guard needs', async () => {
    const { token, expiresAt } = await signSessionToken(claims, settings);

    const verified = await verifySessionToken(token, SECRET);

    expect(verified).toMatchObject({
      userId: 'user-1',
      email: 'ada@campus.local',
      scope: SessionScope.FullAccess,
    });
    expect(verified.expiresAt.getTime()).toBeCloseTo(expiresAt.getTime(), -3);
  });

  it('carries the invite on a provisional session, and nothing on a full one', async () => {
    const provisional = await signSessionToken(
      { ...claims, scope: SessionScope.Provisional, inviteId: 'invite-1' },
      settings,
    );
    const full = await signSessionToken(claims, settings);

    expect((await verifySessionToken(provisional.token, SECRET)).inviteId).toBe(
      'invite-1',
    );
    expect(
      (await verifySessionToken(full.token, SECRET)).inviteId,
    ).toBeUndefined();
  });

  it('expires on its own schedule', async () => {
    const issued = new Date(Date.now() - 31 * 60_000);
    const { token } = await signSessionToken(claims, settings, issued);

    await expect(verifySessionToken(token, SECRET)).rejects.toThrow(
      InvalidSessionTokenError,
    );
  });

  it('refuses a token signed with another secret', async () => {
    const { token } = await signSessionToken(claims, settings);

    await expect(verifySessionToken(token, OTHER)).rejects.toThrow(
      InvalidSessionTokenError,
    );
  });

  it('refuses a token minted for somewhere else', async () => {
    const wrongIssuer = await foreign(
      { email: claims.email, scope: SessionScope.FullAccess },
      { issuer: 'somebody-else' },
    );
    const wrongAudience = await foreign(
      { email: claims.email, scope: SessionScope.FullAccess },
      { audience: 'another-app' },
    );

    await expect(verifySessionToken(wrongIssuer, SECRET)).rejects.toThrow(
      InvalidSessionTokenError,
    );
    await expect(verifySessionToken(wrongAudience, SECRET)).rejects.toThrow(
      InvalidSessionTokenError,
    );
  });

  it('refuses a scope it does not know, however well signed', async () => {
    const token = await foreign({ email: claims.email, scope: 'superuser' });

    await expect(verifySessionToken(token, SECRET)).rejects.toThrow(
      InvalidSessionTokenError,
    );
  });

  it('refuses rubbish', async () => {
    await expect(verifySessionToken('not.a.token', SECRET)).rejects.toThrow(
      InvalidSessionTokenError,
    );
    await expect(verifySessionToken('', SECRET)).rejects.toThrow(
      InvalidSessionTokenError,
    );
  });
});
