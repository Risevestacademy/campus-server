import {
  STATE_COOKIE,
  readStateCookie,
  stateCookieOptions,
} from './state-cookie.js';

describe('readStateCookie', () => {
  it('picks its own value out of a crowded header', () => {
    const header = `theme=dark; ${STATE_COOKIE}=abc123; other=1`;

    expect(readStateCookie(header)).toBe('abc123');
  });

  it('reads a value that was percent-encoded on the way out', () => {
    expect(readStateCookie(`${STATE_COOKIE}=a%2Fb%2Bc`)).toBe('a/b+c');
  });

  it('is not fooled by a cookie whose name merely ends the same way', () => {
    expect(readStateCookie(`not_${STATE_COOKIE}=nope`)).toBeUndefined();
  });

  it('yields nothing when the header is absent or holds no such cookie', () => {
    expect(readStateCookie(undefined)).toBeUndefined();
    expect(readStateCookie('')).toBeUndefined();
    expect(readStateCookie('theme=dark')).toBeUndefined();
  });
});

describe('stateCookieOptions', () => {
  it('marks the cookie secure only where the callback is itself secure', () => {
    expect(
      stateCookieOptions('https://api.campus.example.com/v1/auth/google/callback')
        .secure,
    ).toBe(true);
    expect(
      stateCookieOptions('http://localhost:3000/v1/auth/google/callback').secure,
    ).toBe(false);
  });

  it('uses lax, so it survives the redirect back from Google', () => {
    const options = stateCookieOptions('https://api.example.com/cb');

    expect(options.sameSite).toBe('lax');
    expect(options.httpOnly).toBe(true);
  });
});
