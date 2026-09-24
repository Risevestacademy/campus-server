import { createHash } from 'node:crypto';

import {
  buildInviteLink,
  generateInviteToken,
  hashInviteToken,
} from './invite-token.js';

describe('invite-token helpers', () => {
  it('generates a random url-safe token', () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(40);
  });

  it('hashes to SHA-256 hex and never equals the raw token', () => {
    const raw = generateInviteToken();
    const hash = hashInviteToken(raw);
    expect(hash).toBe(createHash('sha256').update(raw, 'utf8').digest('hex'));
    expect(hash).not.toContain(raw);
    expect(hash).toHaveLength(64);
  });

  it('embeds the raw token in a shareable link', () => {
    const link = buildInviteLink('http://localhost:3000/', 'abc 123/xyz');
    expect(link.startsWith('http://localhost:3000/invite?token=')).toBe(true);
    expect(link).toContain(encodeURIComponent('abc 123/xyz'));
  });
});
