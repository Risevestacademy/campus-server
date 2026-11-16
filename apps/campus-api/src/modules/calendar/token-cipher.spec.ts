import { randomBytes } from 'node:crypto';

import { openToken, sealToken } from './token-cipher.js';

const key = randomBytes(32);

describe('token cipher', () => {
  it('opens what it sealed', () => {
    const sealed = sealToken(key, '1//refresh-token', 'user-1');

    expect(sealed).not.toContain('refresh-token');
    expect(openToken(key, sealed, 'user-1')).toBe('1//refresh-token');
  });

  it('seals the same token differently each time', () => {
    expect(sealToken(key, 'token', 'user-1')).not.toBe(
      sealToken(key, 'token', 'user-1'),
    );
  });

  it('does not open for another user', () => {
    const sealed = sealToken(key, 'token', 'user-1');

    expect(() => openToken(key, sealed, 'user-2')).toThrow();
  });

  it('does not open with another key', () => {
    const sealed = sealToken(key, 'token', 'user-1');

    expect(() => openToken(randomBytes(32), sealed, 'user-1')).toThrow();
  });

  it('does not open once tampered with', () => {
    const [version, iv, tag, body] = sealToken(key, 'token', 'user-1').split(
      '.',
    );
    const flipped = Buffer.from(body, 'base64url');
    flipped[0] ^= 1;

    expect(() =>
      openToken(
        key,
        [version, iv, tag, flipped.toString('base64url')].join('.'),
        'user-1',
      ),
    ).toThrow();
  });

  it('refuses something that was never sealed', () => {
    expect(() => openToken(key, 'plain-refresh-token', 'user-1')).toThrow(
      'not a sealed token',
    );
  });
});
