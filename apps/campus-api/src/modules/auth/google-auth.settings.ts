import type { Env } from '../../infra/config/config.module.js';

export interface GoogleAuthSettings {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  stateSecret: string;
}


export function requireGoogleAuth(env: Env): GoogleAuthSettings {
  if (
    !env.FF_GOOGLE_AUTH_ENABLED ||
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.GOOGLE_CALLBACK_URL ||
    !env.AUTH_STATE_SECRET
  ) {
    throw new Error(
      'Google sign-in is not configured on this deployment. Set ' +
        'FF_GOOGLE_AUTH_ENABLED=true along with GOOGLE_CLIENT_ID, ' +
        'GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL and AUTH_STATE_SECRET.',
    );
  }

  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    callbackUrl: env.GOOGLE_CALLBACK_URL,
    stateSecret: env.AUTH_STATE_SECRET,
  };
}
