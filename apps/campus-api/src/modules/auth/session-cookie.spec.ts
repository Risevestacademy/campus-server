import { sessionCookieOptions } from './session-cookie.js';

const expires = new Date('2026-01-01T00:00:00.000Z');

describe('sessionCookieOptions', () => {
  it('is Secure and cross-site when the app is a different site on https', () => {
    const options = sessionCookieOptions(
      'https://api.campus.example.com/v1/auth/google/callback',
      'https://app.other.example',
      expires,
    );

    expect(options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'none',
    });
  });

  it('stays Lax when the app is the same site as the API', () => {
    const options = sessionCookieOptions(
      'https://api.campus.example.com/v1/auth/google/callback',
      'https://app.campus.example.com',
      expires,
    );

    expect(options).toMatchObject({ secure: true, sameSite: 'lax' });
  });

  /**
   * Follows the API's own scheme: a cookie marked Secure over http is dropped
   * by the browser without a word, and the user is bounced back to sign-in.
   */
  it('is not Secure when the API itself is reached over http', () => {
    const options = sessionCookieOptions(
      'http://localhost:3000/v1/auth/google/callback',
      'https://app.campus.example.com',
      expires,
    );

    expect(options).toMatchObject({ secure: false, sameSite: 'lax' });
  });
});
