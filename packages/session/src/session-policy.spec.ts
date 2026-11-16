import { describe, expect, it } from 'vitest';

import {
  isRefreshTokenLive,
  type RefreshTokenLiveness,
} from './session-policy.js';

const now = new Date('2026-11-04T12:00:00.000Z');
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

const cases: [string, RefreshTokenLiveness, boolean][] = [
  ['expired', { revokedAt: null, expiresAt: at(-60_000) }, false],
  [
    'revoked and expired',
    { revokedAt: at(-120_000), expiresAt: at(-60_000) },
    false,
  ],
  [
    'valid with time to spare',
    { revokedAt: null, expiresAt: at(30 * 86_400_000) },
    true,
  ],
  ['expiring at exactly now', { revokedAt: null, expiresAt: at(0) }, false],
  [
    'expiring a millisecond after now',
    { revokedAt: null, expiresAt: at(1) },
    true,
  ],
  [
    'revoked but not yet expired',
    { revokedAt: at(-1_000), expiresAt: at(86_400_000) },
    false,
  ],
  [
    'revoked at exactly now',
    { revokedAt: at(0), expiresAt: at(86_400_000) },
    false,
  ],
];

describe('isRefreshTokenLive', () => {
  it.each(cases)('judges a token %s', (_, token, live) => {
    expect(isRefreshTokenLive(token, now)).toBe(live);
  });
});
