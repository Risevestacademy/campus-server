import type { PinoLogger } from 'nestjs-pino';

import { InvalidArgumentException } from '../../shared/exceptions/index.js';
import type { UsersService } from '../users/users.service.js';
import type {
  CalendarGrant,
  CalendarGrantsService,
} from './calendar-grants.service.js';
import type { CalendarStateService } from './calendar-state.service.js';
import {
  CalendarConnectFailedError,
  CalendarNotConfiguredError,
  CalendarUnavailableError,
} from './calendar.exceptions.js';
import {
  GrantWithdrawnError,
  type GoogleCalendarClient,
} from './google-calendar.client.js';
import {
  GoogleCalendarService,
  SWEEP_INTERVAL_MS,
} from './google-calendar.service.js';

const CALENDAR = 'https://www.googleapis.com/auth/calendar.events.readonly';

const GRANT: CalendarGrant = {
  userId: 'user-1',
  refreshToken: 'google-refresh',
  sealed: 'v1.sealed',
};

const grants = {
  find: vi.fn(),
  save: vi.fn(),
  forget: vi.fn(),
  remove: vi.fn(),
  removeLapsed: vi.fn(),
};
const google = {
  authorizationUrl: vi.fn(),
  redeem: vi.fn(),
  accessToken: vi.fn(),
  revoke: vi.fn(),
};
const states = { issue: vi.fn(), verify: vi.fn() };
const users = { findById: vi.fn() };
const fetch = vi.fn();
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setContext: vi.fn(),
};

function calendar(): GoogleCalendarService {
  return new GoogleCalendarService(
    grants as unknown as CalendarGrantsService,
    google as unknown as GoogleCalendarClient,
    states as unknown as CalendarStateService,
    users as unknown as UsersService,
    fetch,
    logger as unknown as PinoLogger,
  );
}

const answer = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
  });

const standup = {
  id: 'standup_20261027',
  status: 'confirmed',
  summary: 'Backend standup',
  htmlLink: 'https://www.google.com/calendar/event?eid=abc',
  hangoutLink: 'https://meet.google.com/abc-defg-hij',
  start: { dateTime: '2026-10-27T10:00:00+01:00' },
  end: { dateTime: '2026-10-27T10:30:00+01:00' },
  attendees: [
    { email: 'osemen@campus.local', responseStatus: 'accepted' },
    { self: true, responseStatus: 'tentative' },
  ],
};

const redeemed = (overrides = {}) => ({
  subject: 'google-sub-1',
  scopes: ['openid', CALENDAR],
  refreshToken: 'new-refresh',
  accessToken: 'new-access',
  ...overrides,
});

let issued = 0;
beforeEach(() => {
  vi.resetAllMocks();
  issued = 0;
  grants.find.mockResolvedValue(GRANT);
  grants.removeLapsed.mockResolvedValue([]);
  google.accessToken.mockImplementation(() => {
    issued += 1;
    return Promise.resolve({
      token: `access-${issued}`,
      expiresAt: Date.now() + 3_600_000,
    });
  });
  google.redeem.mockResolvedValue(redeemed());
  users.findById.mockResolvedValue({
    id: 'user-1',
    providerId: 'google-sub-1',
  });
  fetch.mockImplementation(() => Promise.resolve(answer(200, { items: [] })));
});

describe('connecting', () => {
  it('sends the member to Google with a state that names them', () => {
    states.issue.mockReturnValue('the-state');
    google.authorizationUrl.mockReturnValue('https://accounts.google.com/x');

    expect(
      calendar().connectUrl({
        id: 'user-1',
        email: 'ada@campus.local',
      } as never),
    ).toBe('https://accounts.google.com/x');
    expect(states.issue).toHaveBeenCalledWith('user-1');
    expect(google.authorizationUrl).toHaveBeenCalledWith(
      'the-state',
      'ada@campus.local',
    );
  });

  it('keeps the grant Google hands back to the member who asked', async () => {
    await calendar().completeConnect('user-1', { code: 'c', state: 's' });

    expect(states.verify).toHaveBeenCalledWith('s', 'user-1');
    expect(google.redeem).toHaveBeenCalledWith('c', 'web');
    expect(grants.save).toHaveBeenCalledWith('user-1', 'new-refresh');
    expect(google.revoke).not.toHaveBeenCalled();
  });

  it('checks the state before anything reaches Google', async () => {
    states.verify.mockImplementation(() => {
      throw new CalendarConnectFailedError('invalid_state');
    });

    await expect(
      calendar().completeConnect('user-1', { code: 'c', state: 's' }),
    ).rejects.toMatchObject({ reason: 'invalid_state' });
    expect(google.redeem).not.toHaveBeenCalled();
  });

  it.each([
    [{ state: 's', error: 'access_denied' }, 'denied'],
    [{ state: 's' }, 'missing_code'],
  ])('reports %o as %s', async (query, reason) => {
    await expect(
      calendar().completeConnect('user-1', query),
    ).rejects.toMatchObject({ reason });
    expect(google.redeem).not.toHaveBeenCalled();
  });

  it('redeems a native app’s code as the app’s', async () => {
    await calendar().connectWithAppCode('user-1', 'server-code');

    expect(google.redeem).toHaveBeenCalledWith('server-code', 'app');
    expect(grants.save).toHaveBeenCalledWith('user-1', 'new-refresh');
  });

  it('refuses, and revokes, another Google account’s calendar', async () => {
    google.redeem.mockResolvedValue(redeemed({ subject: 'somebody-else' }));

    await expect(
      calendar().connectWithAppCode('user-1', 'server-code'),
    ).rejects.toMatchObject({ reason: 'wrong_account' });
    expect(google.revoke).toHaveBeenCalledWith('new-refresh');
    expect(grants.save).not.toHaveBeenCalled();
  });

  it('refuses an account that has never signed in with Google', async () => {
    users.findById.mockResolvedValue({ id: 'user-1', providerId: null });

    await expect(
      calendar().connectWithAppCode('user-1', 'server-code'),
    ).rejects.toMatchObject({ reason: 'wrong_account' });
  });

  it('refuses a grant without the calendar in it', async () => {
    google.redeem.mockResolvedValue(redeemed({ scopes: ['openid'] }));

    await expect(
      calendar().connectWithAppCode('user-1', 'server-code'),
    ).rejects.toMatchObject({ reason: 'not_granted' });
    expect(grants.save).not.toHaveBeenCalled();
  });

  // Revoking would end the member's whole grant, a working connection too.
  it('refuses a code with no refresh token, and revokes nothing', async () => {
    google.redeem.mockResolvedValue(redeemed({ refreshToken: undefined }));

    await expect(
      calendar().connectWithAppCode('user-1', 'server-code'),
    ).rejects.toMatchObject({ reason: 'no_refresh_token' });
    expect(google.revoke).not.toHaveBeenCalled();
    expect(grants.save).not.toHaveBeenCalled();
  });

  it('reads with the new grant once reconnected', async () => {
    const service = calendar();
    await service.events('user-1', {});

    await service.connectWithAppCode('user-1', 'server-code');
    await service.events('user-1', {});

    expect(google.accessToken).toHaveBeenCalledTimes(2);
  });
});

describe('events', () => {
  it('reads the member’s primary calendar for the window asked', async () => {
    fetch.mockResolvedValue(answer(200, { items: [standup] }));

    const result = await calendar().events('user-1', {
      from: '2026-10-26T00:00:00Z',
      to: '2026-11-02T00:00:00Z',
    });

    expect(result).toEqual({
      connected: true,
      events: [
        {
          id: 'standup_20261027',
          title: 'Backend standup',
          start: '2026-10-27T10:00:00+01:00',
          end: '2026-10-27T10:30:00+01:00',
          allDay: false,
          status: 'confirmed',
          response: 'tentative',
          location: null,
          meetingUrl: 'https://meet.google.com/abc-defg-hij',
          url: 'https://www.google.com/calendar/event?eid=abc',
        },
      ],
    });
    const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/calendar/v3/calendars/primary/events');
    expect(url.searchParams.get('timeMin')).toBe('2026-10-26T00:00:00.000Z');
    expect(url.searchParams.get('timeMax')).toBe('2026-11-02T00:00:00.000Z');
    expect(url.searchParams.get('singleEvents')).toBe('true');
    expect(init.headers).toEqual({ Authorization: 'Bearer access-1' });
  });

  it('defaults to the coming week', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-24T12:00:00Z') });
    try {
      await calendar().events('user-1', {});
    } finally {
      vi.useRealTimers();
    }

    const [url] = fetch.mock.calls[0] as [URL];
    expect(url.searchParams.get('timeMin')).toBe('2026-10-24T12:00:00.000Z');
    expect(url.searchParams.get('timeMax')).toBe('2026-10-31T12:00:00.000Z');
  });

  it('gives all-day events as dates, and leaves cancelled ones out', async () => {
    fetch.mockResolvedValue(
      answer(200, {
        items: [
          {
            id: 'offsite',
            summary: 'Offsite',
            start: { date: '2026-10-28' },
            end: { date: '2026-10-29' },
          },
          { id: 'gone', status: 'cancelled' },
        ],
      }),
    );

    const { events } = await calendar().events('user-1', {});

    expect(events).toEqual([
      expect.objectContaining({
        id: 'offsite',
        start: '2026-10-28',
        end: '2026-10-29',
        allDay: true,
        response: null,
      }),
    ]);
  });

  it('follows the pages Google splits a long answer into', async () => {
    fetch
      .mockResolvedValueOnce(
        answer(200, { items: [standup], nextPageToken: 'page-2' }),
      )
      .mockResolvedValueOnce(
        answer(200, { items: [{ ...standup, id: 'standup_20261028' }] }),
      );

    const { events } = await calendar().events('user-1', {});

    expect(events.map((e) => e.id)).toEqual([
      'standup_20261027',
      'standup_20261028',
    ]);
    const [second] = fetch.mock.calls[1] as [URL];
    expect(second.searchParams.get('pageToken')).toBe('page-2');
  });

  it('reuses an access token until it is about to run out', async () => {
    const service = calendar();

    await service.events('user-1', {});
    await service.events('user-1', {});

    expect(google.accessToken).toHaveBeenCalledTimes(1);
  });

  it('answers not connected for a member who never connected', async () => {
    grants.find.mockResolvedValue(null);

    await expect(calendar().events('user-1', {})).resolves.toEqual({
      connected: false,
      events: [],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('forgets a grant Google has withdrawn', async () => {
    google.accessToken.mockRejectedValue(new GrantWithdrawnError());

    await expect(calendar().events('user-1', {})).resolves.toEqual({
      connected: false,
      events: [],
    });
    expect(grants.forget).toHaveBeenCalledWith(GRANT);
  });

  it('forgets a grant that no longer covers the calendar', async () => {
    fetch.mockResolvedValue(
      answer(403, {
        error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] },
      }),
    );

    await expect(calendar().events('user-1', {})).resolves.toMatchObject({
      connected: false,
    });
    expect(grants.forget).toHaveBeenCalledWith(GRANT);
  });

  it('gets a fresh access token once when Google rejects the one it had', async () => {
    fetch
      .mockResolvedValueOnce(answer(401, {}))
      .mockResolvedValueOnce(answer(200, { items: [standup] }));

    const { events } = await calendar().events('user-1', {});

    expect(events).toHaveLength(1);
    expect(google.accessToken).toHaveBeenCalledTimes(2);
    const [, init] = fetch.mock.calls[1] as [URL, RequestInit];
    expect(init.headers).toEqual({ Authorization: 'Bearer access-2' });
  });

  it('reports Google unavailable, and keeps the grant, when it fails', async () => {
    fetch.mockResolvedValue(answer(503, 'backend error'));

    await expect(calendar().events('user-1', {})).rejects.toThrow(
      CalendarUnavailableError,
    );
    expect(grants.forget).not.toHaveBeenCalled();
  });

  it('reports Google unavailable when it cannot be reached', async () => {
    fetch.mockRejectedValue(new TypeError('fetch failed'));

    await expect(calendar().events('user-1', {})).rejects.toThrow(
      CalendarUnavailableError,
    );
  });

  it.each([
    [{ from: '2026-10-27T00:00:00Z', to: '2026-10-26T00:00:00Z' }],
    [{ from: '2026-10-26T00:00:00Z', to: '2026-10-26T00:00:00Z' }],
    [{ from: '2026-10-01T00:00:00Z', to: '2026-12-31T00:00:00Z' }],
  ])('refuses a window that is backwards, empty or too long: %o', async (q) => {
    await expect(calendar().events('user-1', q)).rejects.toThrow(
      InvalidArgumentException,
    );
  });

  it('is not there while the calendar is switched off', async () => {
    grants.find.mockRejectedValue(new CalendarNotConfiguredError());

    await expect(
      calendar().events('user-1', { from: 'not checked first' }),
    ).rejects.toThrow(CalendarNotConfiguredError);
  });
});

describe('disconnect', () => {
  it('forgets the grant and revokes it at Google', async () => {
    grants.remove.mockResolvedValue('google-refresh');

    await calendar().disconnect('user-1');

    expect(grants.remove).toHaveBeenCalledWith('user-1');
    expect(google.revoke).toHaveBeenCalledWith('google-refresh');
  });

  it('does nothing at Google when there was no grant', async () => {
    grants.remove.mockResolvedValue(null);

    await calendar().disconnect('user-1');

    expect(google.revoke).toHaveBeenCalledWith(undefined);
  });

  it('stops using a cached access token once disconnected', async () => {
    const service = calendar();
    await service.events('user-1', {});

    await service.disconnect('user-1');
    await service.events('user-1', {});

    expect(google.accessToken).toHaveBeenCalledTimes(2);
  });
});

describe('retention', () => {
  it('revokes every grant whose access has ended', async () => {
    grants.removeLapsed.mockResolvedValue(['left-refresh', 'gone-refresh']);

    await calendar().sweep(new Date('2026-10-25T12:00:00Z'));

    expect(grants.removeLapsed).toHaveBeenCalledWith(
      new Date('2026-10-25T12:00:00Z'),
    );
    expect(google.revoke).toHaveBeenCalledWith('left-refresh');
    expect(google.revoke).toHaveBeenCalledWith('gone-refresh');
  });

  it('sweeps on the back of calendar requests, at most every ten minutes', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-25T12:00:00Z') });
    try {
      const service = calendar();
      await service.events('user-1', {});
      await service.events('user-1', {});
      expect(grants.removeLapsed).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + SWEEP_INTERVAL_MS);
      await service.events('user-1', {});
      expect(grants.removeLapsed).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers the request even when the sweep fails', async () => {
    grants.removeLapsed.mockRejectedValue(new Error('database gone'));

    await expect(calendar().events('user-1', {})).resolves.toMatchObject({
      connected: true,
    });
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());
  });
});
