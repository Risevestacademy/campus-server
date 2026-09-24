import type { Env } from '../../infra/config/config.module.js';
import { GoogleSignInFailedError } from './auth.exceptions.js';
import { OAuthStateService } from './oauth-state.service.js';

const config = {
  FF_GOOGLE_AUTH_ENABLED: true,
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_CALLBACK_URL: 'http://localhost:3000/v1/auth/google/callback',
  AUTH_STATE_SECRET: 'a-state-secret-of-at-least-32-characters',
  AUTH_SESSION_SECRET: 'a-session-secret-of-at-least-32-characters',
} as Env;

const service = new OAuthStateService(config);

const reasonOf = (fn: () => void): string => {
  try {
    fn();
  } catch (error) {
    return (error as GoogleSignInFailedError).reason;
  }
  throw new Error('expected the call to throw');
};

describe('issue', () => {
  it('produces a state the matching nonce verifies', () => {
    const { state, nonce } = service.issue();

    expect(() => service.verify(state, nonce)).not.toThrow();
  });

  it('never repeats a nonce', () => {
    expect(service.issue().nonce).not.toBe(service.issue().nonce);
  });
});

describe('verify', () => {
  it('rejects a state nobody issued', () => {
    expect(reasonOf(() => service.verify('made.up', 'nonce'))).toBe(
      'invalid_state',
    );
  });

  it('rejects a state with no signature at all', () => {
    const { nonce } = service.issue();

    expect(reasonOf(() => service.verify('nosignature', nonce))).toBe(
      'invalid_state',
    );
  });

  it('rejects an edited payload', () => {
    const { state, nonce } = service.issue();
    const [, signature] = state.split('.');
    const forged = Buffer.from(
      JSON.stringify({ n: nonce, e: Date.now() + 60_000 }),
      'utf8',
    ).toString('base64url');

    expect(reasonOf(() => service.verify(`${forged}.${signature}`, nonce))).toBe(
      'invalid_state',
    );
  });

  it('rejects a signature from a different secret', () => {
    const { state, nonce } = service.issue();
    const other = new OAuthStateService({
      ...config,
      AUTH_STATE_SECRET: 'a-completely-different-secret-value-32',
      AUTH_SESSION_SECRET: 'a-session-secret-of-at-least-32-characters',
    } as Env);
    const [body] = state.split('.');
    const foreign = other.issue().state.split('.')[1];

    expect(reasonOf(() => service.verify(`${body}.${foreign}`, nonce))).toBe(
      'invalid_state',
    );
  });

  it('rejects a valid state arriving without its cookie', () => {
    const { state } = service.issue();

    expect(reasonOf(() => service.verify(state, undefined))).toBe(
      'invalid_state',
    );
  });

  it('rejects a state paired with someone else’s nonce', () => {
    const { state } = service.issue();
    const { nonce } = service.issue();

    expect(reasonOf(() => service.verify(state, nonce))).toBe('invalid_state');
  });

  it('rejects a state that has aged out', () => {
    const issuedAt = Date.now();
    const { state, nonce } = service.issue(issuedAt);

    expect(
      reasonOf(() => service.verify(state, nonce, issuedAt + 11 * 60 * 1000)),
    ).toBe('expired_state');
  });

  it('still accepts one a minute before it expires', () => {
    const issuedAt = Date.now();
    const { state, nonce } = service.issue(issuedAt);

    expect(() =>
      service.verify(state, nonce, issuedAt + 9 * 60 * 1000),
    ).not.toThrow();
  });
});
