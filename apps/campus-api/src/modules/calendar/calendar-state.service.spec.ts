import type { Env } from '../../infra/config/config.module.js';
import { CalendarConnectFailedError } from './calendar.exceptions.js';
import { CalendarStateService } from './calendar-state.service.js';

const config = {
  FF_GOOGLE_CALENDAR_ENABLED: true,
  GOOGLE_CLIENT_ID: 'web-client',
  GOOGLE_CLIENT_SECRET: 'web-secret',
  GOOGLE_CALENDAR_CALLBACK_URL: 'http://localhost/v1/calendar/connect/callback',
  AUTH_STATE_SECRET: 'a-state-secret-of-at-least-32-characters',
  GOOGLE_CALENDAR_TOKEN_KEY: Buffer.alloc(32).toString('base64'),
} as Env;

const states = new CalendarStateService(config);
const NOW = 1_800_000_000_000;

function refusal(fn: () => void): string | undefined {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CalendarConnectFailedError);
    return (err as CalendarConnectFailedError).reason;
  }
  return undefined;
}

describe('CalendarStateService', () => {
  it('takes back a state it issued, for the same member', () => {
    const state = states.issue('user-1', NOW);

    expect(refusal(() => states.verify(state, 'user-1', NOW + 1000))).toBe(
      undefined,
    );
  });

  // Somebody else's half-finished connection, completed in a victim's
  // browser, would otherwise put the victim's calendar on their account.
  it('refuses a state issued to somebody else', () => {
    const state = states.issue('attacker', NOW);

    expect(refusal(() => states.verify(state, 'victim', NOW))).toBe(
      'invalid_state',
    );
  });

  it('refuses a state after ten minutes', () => {
    const state = states.issue('user-1', NOW);

    expect(
      refusal(() => states.verify(state, 'user-1', NOW + 10 * 60 * 1000)),
    ).toBe('expired_state');
  });

  it('refuses a state that was tampered with', () => {
    const [, signature] = states.issue('user-1', NOW).split('.');
    const forged = Buffer.from(
      JSON.stringify({ u: 'user-2', e: NOW + 60_000 }),
    ).toString('base64url');

    expect(
      refusal(() => states.verify(`${forged}.${signature}`, 'user-2', NOW)),
    ).toBe('invalid_state');
  });

  it.each([undefined, '', 'one-part', 'a.b.c'])(
    'refuses a malformed state: %s',
    (state) => {
      expect(refusal(() => states.verify(state, 'user-1', NOW))).toBe(
        'invalid_state',
      );
    },
  );
});
