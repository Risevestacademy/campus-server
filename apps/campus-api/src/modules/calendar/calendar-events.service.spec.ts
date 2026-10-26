import type { PinoLogger } from 'nestjs-pino';

import { InvalidArgumentException } from '../../shared/exceptions/index.js';
import { AccessTokenCache } from './access-token-cache.js';
import type {
  CalendarGrant,
  CalendarGrantsService,
} from './calendar-grants.service.js';
import type { CalendarRevocationService } from './calendar-revocation.service.js';
import {
  CalendarEventsService,
  READ_BUDGET_MS,
} from './calendar-events.service.js';
import {
  CalendarNotConfiguredError,
  CalendarUnavailableError,
} from './calendar.exceptions.js';
import {
  GrantWithdrawnError,
  type GoogleCalendarClient,
} from './google-calendar.client.js';

const GRANT: CalendarGrant = {
  userId: 'user-1',
  refreshToken: 'google-refresh',
  sealed: 'v1.sealed',
};

const grants = { find: vi.fn(), forget: vi.fn() };
const google = { refresh: vi.fn() };
const revocations = { sweepIfDue: vi.fn() };
const fetch = vi.fn();
const logger = { info: vi.fn(), error: vi.fn(), setContext: vi.fn() };

let tokens: AccessTokenCache;
function calendar(): CalendarEventsService {
  tokens = new AccessTokenCache(google as unknown as GoogleCalendarClient);
  return new CalendarEventsService(
    grants as unknown as CalendarGrantsService,
    tokens,
    revocations as unknown as CalendarRevocationService,
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

let issued = 0;
beforeEach(() => {
  vi.resetAllMocks();
  issued = 0;
  grants.find.mockResolvedValue(GRANT);
  google.refresh.mockImplementation(() => {
    issued += 1;
    return Promise.resolve({
      token: `access-${issued}`,
      expiresAt: Date.now() + 3_600_000,
    });
  });
  fetch.mockImplementation(() => Promise.resolve(answer(200, { items: [] })));
});

it('reads the member’s primary calendar for the window asked', async () => {
  fetch.mockResolvedValue(answer(200, { items: [standup] }));

  const result = await calendar().events('user-1', {
    from: '2026-10-26T00:00:00Z',
    to: '2026-11-02T00:00:00Z',
  });

  expect(result).toEqual({
    connected: true,
    truncated: false,
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

  const { events, truncated } = await calendar().events('user-1', {});

  expect(events.map((e) => e.id)).toEqual([
    'standup_20261027',
    'standup_20261028',
  ]);
  expect(truncated).toBe(false);
  const [second] = fetch.mock.calls[1] as [URL];
  expect(second.searchParams.get('pageToken')).toBe('page-2');
});

it('says so when it stops before the end of a long window', async () => {
  fetch.mockImplementation(() =>
    Promise.resolve(answer(200, { items: [standup], nextPageToken: 'more' })),
  );

  const { events, truncated } = await calendar().events('user-1', {});

  expect(fetch).toHaveBeenCalledTimes(4);
  expect(events).toHaveLength(4);
  expect(truncated).toBe(true);
});

it('holds the whole read to one deadline: the refresh and every page', async () => {
  fetch
    .mockResolvedValueOnce(
      answer(200, { items: [standup], nextPageToken: 'page-2' }),
    )
    .mockResolvedValueOnce(answer(200, { items: [] }));

  await calendar().events('user-1', {});

  const [, refreshSignal] = google.refresh.mock.calls[0] as [
    string,
    AbortSignal,
  ];
  const signals = fetch.mock.calls.map(
    ([, init]) => (init as RequestInit).signal,
  );
  expect(refreshSignal).toBeInstanceOf(AbortSignal);
  expect(signals).toEqual([refreshSignal, refreshSignal]);
});

it('reports Google unavailable once the deadline has passed', async () => {
  fetch.mockImplementation((_url: URL, init: RequestInit) =>
    init.signal?.aborted
      ? Promise.reject(new DOMException('aborted', 'TimeoutError'))
      : Promise.resolve(
          answer(200, { items: [standup], nextPageToken: 'more' }),
        ),
  );
  const timeout = vi
    .spyOn(AbortSignal, 'timeout')
    .mockReturnValueOnce(AbortSignal.abort());

  try {
    await expect(calendar().events('user-1', {})).rejects.toThrow(
      CalendarUnavailableError,
    );
    expect(timeout).toHaveBeenCalledWith(READ_BUDGET_MS);
  } finally {
    timeout.mockRestore();
  }
});

it('reuses an access token until it is about to run out', async () => {
  const service = calendar();

  await service.events('user-1', {});
  await service.events('user-1', {});

  expect(google.refresh).toHaveBeenCalledTimes(1);
});

it('answers not connected for a member who never connected', async () => {
  grants.find.mockResolvedValue(null);

  await expect(calendar().events('user-1', {})).resolves.toEqual({
    connected: false,
    events: [],
    truncated: false,
  });
  expect(fetch).not.toHaveBeenCalled();
});

it('forgets a grant Google has withdrawn', async () => {
  google.refresh.mockRejectedValue(new GrantWithdrawnError());

  await expect(calendar().events('user-1', {})).resolves.toMatchObject({
    connected: false,
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
  expect(google.refresh).toHaveBeenCalledTimes(2);
  const [, init] = fetch.mock.calls[1] as [URL, RequestInit];
  expect(init.headers).toEqual({ Authorization: 'Bearer access-2' });
});

it('gives up when Google rejects the fresh one too', async () => {
  fetch.mockImplementation(() => Promise.resolve(answer(401, {})));

  await expect(calendar().events('user-1', {})).rejects.toThrow(
    CalendarUnavailableError,
  );
  expect(google.refresh).toHaveBeenCalledTimes(2);
  expect(grants.forget).not.toHaveBeenCalled();
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

it('is not there while the calendar is switched off, but still sweeps', async () => {
  grants.find.mockRejectedValue(new CalendarNotConfiguredError());

  await expect(
    calendar().events('user-1', { from: 'not checked first' }),
  ).rejects.toThrow(CalendarNotConfiguredError);
  expect(revocations.sweepIfDue).toHaveBeenCalled();
});
