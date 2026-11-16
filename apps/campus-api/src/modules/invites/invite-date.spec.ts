import { resolveExceptionStatus } from '../../shared/exceptions/index.js';
import { INVALID_DATE_MESSAGE, parseInviteDate } from './invite-date.js';
import { InviteInvalidArgumentException } from './invites.exceptions.js';

describe('parseInviteDate', () => {
  it.each([
    ['date-only', '2030-06-01'],
    ['with an offset', '2030-06-01T12:00:00+02:00'],
    ['without an offset', '2030-06-01T12:00:00'],
  ])('returns the instant JavaScript reads for a %s value', (_label, value) => {
    expect(parseInviteDate(value, 'guestAccessExpiresAt').getTime()).toBe(
      new Date(value).getTime(),
    );
  });

  it.each([
    ['an ISO week date', '2026-W43-2'],
    ['a week date with no day', '2026-W43'],
    ['an ISO ordinal date', '2026-123'],
    ['another ordinal date', '2026-366'],
  ])('refuses %s that @IsDateString accepts', (_label, value) => {
    let thrown: unknown;
    try {
      parseInviteDate(value, 'guestAccessExpiresAt');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(InviteInvalidArgumentException);
    const error = thrown as InviteInvalidArgumentException;
    expect(resolveExceptionStatus(error)).toBe(400);
    expect(error.message).toBe(`guestAccessExpiresAt ${INVALID_DATE_MESSAGE}`);
    expect(error.details).toEqual({ field: 'guestAccessExpiresAt' });
  });
});
