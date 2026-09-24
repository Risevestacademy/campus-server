import type { Env } from '../../infra/config/config.module.js';
import { GoogleAuthNotConfiguredError } from './auth.exceptions.js';

export interface GoogleAuthSettings {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  stateSecret: string;
  sessionSecret: string;
}


export function requireGoogleAuth(env: Env): GoogleAuthSettings {
  if (
    !env.FF_GOOGLE_AUTH_ENABLED ||
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.GOOGLE_CALLBACK_URL ||
    !env.AUTH_STATE_SECRET ||
    !env.AUTH_SESSION_SECRET
  ) {
    // Env already refuses to boot with the flag on and a value missing, so
    // reaching here means the flag is off — the default in .env.example.
    throw new GoogleAuthNotConfiguredError();
  }

  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    callbackUrl: env.GOOGLE_CALLBACK_URL,
    stateSecret: env.AUTH_STATE_SECRET,
    sessionSecret: env.AUTH_SESSION_SECRET,
  };
}
