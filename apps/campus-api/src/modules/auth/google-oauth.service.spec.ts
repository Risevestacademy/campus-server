import { OAuth2Client } from 'google-auth-library';
import type { PinoLogger } from 'nestjs-pino';

import type { Env } from '../../infra/config/config.module.js';
import {
  GoogleAuthNotConfiguredError,
  GoogleSignInFailedError,
} from './auth.exceptions.js';
import { GoogleOAuthService } from './google-oauth.service.js';

const WEB_CLIENT = 'web-client.apps.googleusercontent.com';
const IOS_CLIENT = 'ios-client.apps.googleusercontent.com';
const ANDROID_CLIENT = 'android-client.apps.googleusercontent.com';

const logger = { error: vi.fn(), setContext: vi.fn() };

function service(overrides: Partial<Env> = {}): GoogleOAuthService {
  return new GoogleOAuthService(
    {
      FF_GOOGLE_AUTH_ENABLED: true,
      GOOGLE_CLIENT_ID: WEB_CLIENT,
      GOOGLE_CLIENT_SECRET: 'a-web-client-secret',
      GOOGLE_CALLBACK_URL: 'http://localhost:3000/v1/auth/google/callback',
      AUTH_STATE_SECRET: 'a-state-secret-of-at-least-32-characters',
      AUTH_SESSION_SECRET: 'a-session-secret-of-at-least-32-characters',
      ...overrides,
    } as Env,
    logger as unknown as PinoLogger,
  );
}

const verify = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken');

function googleAnswers(payload: Record<string, unknown> | undefined): void {
  verify.mockImplementation(() =>
    Promise.resolve({ getPayload: () => payload } as never),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  googleAnswers({
    sub: 'google-sub-1',
    email: 'ada@campus.local',
    email_verified: true,
    given_name: 'Ada',
    family_name: 'Lovelace',
    name: 'Ada Lovelace',
  });
});

describe('verifyIdToken', () => {
  it('reads the identity out of a token Google vouches for', async () => {
    await expect(service().verifyIdToken('id-token')).resolves.toEqual({
      subject: 'google-sub-1',
      email: 'ada@campus.local',
      emailVerified: true,
      firstName: 'Ada',
      lastName: 'Lovelace',
      displayName: 'Ada Lovelace',
      avatarUrl: null,
    });
  });

  // The audience is the whole of the check that the token was minted for
  // this campus and not for some other app the user also signs in to.
  it('accepts only the web client when no native client is named', async () => {
    await service().verifyIdToken('id-token');

    expect(verify).toHaveBeenCalledWith({
      idToken: 'id-token',
      audience: [WEB_CLIENT],
    });
  });

  it('accepts the native clients the deployment names, and the web one', async () => {
    await service({
      GOOGLE_MOBILE_CLIENT_IDS: ` ${IOS_CLIENT} ,${ANDROID_CLIENT},`,
    }).verifyIdToken('id-token');

    expect(verify).toHaveBeenCalledWith({
      idToken: 'id-token',
      audience: [WEB_CLIENT, IOS_CLIENT, ANDROID_CLIENT],
    });
  });

  it('refuses a token Google will not vouch for, and writes down why', async () => {
    verify.mockImplementation(() =>
      Promise.reject(
        new Error('Wrong recipient, payload audience != requiredAudience'),
      ),
    );

    await expect(service().verifyIdToken('id-token')).rejects.toMatchObject({
      constructor: GoogleSignInFailedError,
      reason: 'exchange_failed',
    });
    expect(logger.error).toHaveBeenCalled();
  });

  it('refuses a token that names nobody', async () => {
    googleAnswers({ sub: 'google-sub-1' });

    await expect(service().verifyIdToken('id-token')).rejects.toMatchObject({
      reason: 'incomplete_profile',
    });
  });

  it('reports an unverified address rather than deciding about it', async () => {
    googleAnswers({ sub: 'google-sub-1', email: 'ada@campus.local' });

    await expect(service().verifyIdToken('id-token')).resolves.toMatchObject({
      emailVerified: false,
    });
  });

  it('is not there at all while Google sign-in is switched off', async () => {
    await expect(
      service({ FF_GOOGLE_AUTH_ENABLED: false }).verifyIdToken('id-token'),
    ).rejects.toThrow(GoogleAuthNotConfiguredError);
    expect(verify).not.toHaveBeenCalled();
  });
});
