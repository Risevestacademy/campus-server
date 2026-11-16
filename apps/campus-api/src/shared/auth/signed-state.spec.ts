import { readState, safeEqual, signState } from './signed-state.js';

const SECRET = 'a-state-secret-of-at-least-32-characters';

describe('signed state', () => {
  it('reads back what it signed', () => {
    const state = signState(SECRET, { u: 'user-1', e: 5 });

    expect(readState(SECRET, state)).toEqual({ u: 'user-1', e: 5 });
  });

  it('keeps one context’s states out of another', () => {
    const state = signState(SECRET, { u: 'user-1' }, 'calendar');

    expect(readState(SECRET, state, 'calendar')).toEqual({ u: 'user-1' });
    expect(readState(SECRET, state)).toBeNull();
    expect(
      readState(SECRET, signState(SECRET, { u: 'user-1' }), 'calendar'),
    ).toBeNull();
  });

  it('refuses another secret, a changed body and a malformed state', () => {
    const state = signState(SECRET, { u: 'user-1' });
    const [, signature] = state.split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'user-2' })).toString(
      'base64url',
    );

    expect(readState('another-secret-of-at-least-32-chars', state)).toBeNull();
    expect(readState(SECRET, `${forged}.${signature}`)).toBeNull();
    for (const malformed of [undefined, '', 'one', 'a.b.c']) {
      expect(readState(SECRET, malformed)).toBeNull();
    }
  });

  it('compares in constant time, and only equal strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
