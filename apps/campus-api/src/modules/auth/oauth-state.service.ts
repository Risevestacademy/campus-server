import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import {
  STATE_TTL_MS,
  readState,
  safeEqual,
  signState,
} from '../../shared/auth/signed-state.js';
import { GoogleSignInFailedError } from './auth.exceptions.js';
import { requireGoogleAuth } from './google-auth.settings.js';

export interface IssuedState {
  state: string;
  nonce: string;
}

interface StatePayload {
  /** Digest of the cookie nonce, never the nonce itself. */
  n: string;
  e: number;
}

/**
 * Guards the callback against forged sign-ins.
 */
@Injectable()
export class OAuthStateService {
  constructor(@Inject(CONFIG) private readonly config: Env) {}

  issue(now: number = Date.now()): IssuedState {
    const nonce = randomBytes(32).toString('base64url');
    // The state travels through Google and lands in this API's own request
    // log; the cookie is httpOnly precisely so its value stays in the
    // browser. Carrying a digest keeps both true.
    const payload: StatePayload = { n: digest(nonce), e: now + STATE_TTL_MS };

    return { state: signState(this.secret, payload), nonce };
  }

  /** Throws unless the state is ours, in date, and matched by the cookie. */
  verify(
    state: string | undefined,
    nonce: string | undefined,
    now: number = Date.now(),
  ): void {
    if (!state || !nonce) {
      throw new GoogleSignInFailedError('invalid_state');
    }

    const payload = readState(this.secret, state);
    if (!isStatePayload(payload)) {
      throw new GoogleSignInFailedError('invalid_state');
    }
    if (payload.e <= now) {
      throw new GoogleSignInFailedError('expired_state');
    }
    if (!safeEqual(payload.n, digest(nonce))) {
      throw new GoogleSignInFailedError('invalid_state');
    }
  }

  private get secret(): string {
    return requireGoogleAuth(this.config).stateSecret;
  }
}

function digest(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('base64url');
}

function isStatePayload(value: unknown): value is StatePayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StatePayload).n === 'string' &&
    typeof (value as StatePayload).e === 'number'
  );
}
