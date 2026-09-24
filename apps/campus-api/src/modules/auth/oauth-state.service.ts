import { Inject, Injectable } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import { GoogleSignInFailedError } from './auth.exceptions.js';
import { requireGoogleAuth } from './google-auth.settings.js';

const TTL_MS = 10 * 60 * 1000;

export interface IssuedState {
  state: string;
  nonce: string;
}

interface StatePayload {
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
    const body = encode({ n: nonce, e: now + TTL_MS });

    return { state: `${body}.${this.sign(body)}`, nonce };
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

    const [body, signature, ...rest] = state.split('.');
    if (!body || !signature || rest.length > 0) {
      throw new GoogleSignInFailedError('invalid_state');
    }
    if (!matches(signature, this.sign(body))) {
      throw new GoogleSignInFailedError('invalid_state');
    }

    const payload = decode(body);
    if (!payload) {
      throw new GoogleSignInFailedError('invalid_state');
    }
    if (payload.e <= now) {
      throw new GoogleSignInFailedError('expired_state');
    }
    if (!matches(payload.n, nonce)) {
      throw new GoogleSignInFailedError('invalid_state');
    }
  }

  private sign(body: string): string {
    return createHmac('sha256', requireGoogleAuth(this.config).stateSecret)
      .update(body)
      .digest('base64url');
  }
}

function encode(payload: StatePayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decode(body: string): StatePayload | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    );
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as StatePayload).n !== 'string' ||
      typeof (parsed as StatePayload).e !== 'number'
    ) {
      return null;
    }
    return parsed as StatePayload;
  } catch {
    return null;
  }
}

function matches(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');

  return left.length === right.length && timingSafeEqual(left, right);
}
