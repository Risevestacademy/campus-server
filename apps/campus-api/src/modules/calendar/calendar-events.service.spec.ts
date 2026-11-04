import type { PinoLogger } from 'nestjs-pino';

import type { Env } from '../../infra/config/config.module.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { InvalidArgumentException } from '../../shared/exceptions/index.js';
import type { RoomLinksService } from '../room-links/room-links.service.js';
import { SystemRole } from '../users/schema.js';
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

const APP_URL = 'http://localhost:3000';

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
const roomLinks = { resolve: vi.fn() };
const USER: AuthenticatedUser = {
  id: 'user-1',
  email: 'ada@campus.test',
  systemRole: SystemRole.User,
};
const CODE = 'k3F9xQ2pLm';
const ROOM = {
  code: CODE,
  cohortId: 'cohort-1',
  spaceId: 'space-1',
  spaceKey: 'pod-a',
  spaceName: 'Pod A',
  title: 'Design review',
};

let tokens: AccessTokenCache;
function calendar(): CalendarEventsService {
  tokens = new AccessTokenCache(google as unknown as GoogleCalendarClient);
  return new CalendarEventsService(
    grants as unknown as CalendarGrantsService,
    tokens,
    revocations as unknown as CalendarRevocationService,
    fetch,
    { APP_PUBLIC_URL: APP_URL } as Env,
    roomLinks as unknown as RoomLinksService,
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
  roomLinks.resolve.mockResolvedValue([]);
});

it('reads the member’s primary calendar for the window asked', async () => {
  fetch.mockResolvedValue(answer(200, { items: [standup] }));

  const result = await calendar().events(USER, {
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
        room: null,
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
    await calendar().events(USER, {});
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

  const { events } = await calendar().events(USER, {});

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

  const { events, truncated } = await calendar().events(USER, {});

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

  const { events, truncated } = await calendar().events(USER, {});

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

  await calendar().events(USER, {});

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
    await expect(calendar().events(USER, {})).rejects.toThrow(
      CalendarUnavailableError,
    );
    expect(timeout).toHaveBeenCalledWith(READ_BUDGET_MS);
  } finally {
    timeout.mockRestore();
  }
});

it('reuses an access token until it is about to run out', async () => {
  const service = calendar();

  await service.events(USER, {});
  await service.events(USER, {});

  expect(google.refresh).toHaveBeenCalledTimes(1);
});

it('answers not connected for a member who never connected', async () => {
  grants.find.mockResolvedValue(null);

  await expect(calendar().events(USER, {})).resolves.toEqual({
    connected: false,
    events: [],
    truncated: false,
  });
  expect(fetch).not.toHaveBeenCalled();
});

it('forgets a grant Google has withdrawn', async () => {
  google.refresh.mockRejectedValue(new GrantWithdrawnError());

  await expect(calendar().events(USER, {})).resolves.toMatchObject({
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

  await expect(calendar().events(USER, {})).resolves.toMatchObject({
    connected: false,
  });
  expect(grants.forget).toHaveBeenCalledWith(GRANT);
});

it('gets a fresh access token once when Google rejects the one it had', async () => {
  fetch
    .mockResolvedValueOnce(answer(401, {}))
    .mockResolvedValueOnce(answer(200, { items: [standup] }));

  const { events } = await calendar().events(USER, {});

  expect(events).toHaveLength(1);
  expect(google.refresh).toHaveBeenCalledTimes(2);
  const [, init] = fetch.mock.calls[1] as [URL, RequestInit];
  expect(init.headers).toEqual({ Authorization: 'Bearer access-2' });
});

it('gives up when Google rejects the fresh one too', async () => {
  fetch.mockImplementation(() => Promise.resolve(answer(401, {})));

  await expect(calendar().events(USER, {})).rejects.toThrow(
    CalendarUnavailableError,
  );
  expect(google.refresh).toHaveBeenCalledTimes(2);
  expect(grants.forget).not.toHaveBeenCalled();
});

it('reports Google unavailable, and keeps the grant, when it fails', async () => {
  fetch.mockResolvedValue(answer(503, 'backend error'));

  await expect(calendar().events(USER, {})).rejects.toThrow(
    CalendarUnavailableError,
  );
  expect(grants.forget).not.toHaveBeenCalled();
});

it('reports Google unavailable when it cannot be reached', async () => {
  fetch.mockRejectedValue(new TypeError('fetch failed'));

  await expect(calendar().events(USER, {})).rejects.toThrow(
    CalendarUnavailableError,
  );
});

it.each([
  [{ from: '2026-10-27T00:00:00Z', to: '2026-10-26T00:00:00Z' }],
  [{ from: '2026-10-26T00:00:00Z', to: '2026-10-26T00:00:00Z' }],
  [{ from: '2026-10-01T00:00:00Z', to: '2026-12-31T00:00:00Z' }],
])('refuses a window that is backwards, empty or too long: %o', async (q) => {
  await expect(calendar().events(USER, q)).rejects.toThrow(
    InvalidArgumentException,
  );
});

it('is not there while the calendar is switched off, but still sweeps', async () => {
  grants.find.mockRejectedValue(new CalendarNotConfiguredError());

  await expect(
    calendar().events(USER, { from: 'not checked first' }),
  ).rejects.toThrow(CalendarNotConfiguredError);
  expect(revocations.sweepIfDue).toHaveBeenCalled();
});

it('puts an event in the room its location links to', async () => {
  fetch.mockResolvedValue(
    answer(200, {
      items: [{ ...standup, location: `${APP_URL}/join/${CODE}` }],
    }),
  );
  roomLinks.resolve.mockResolvedValue([ROOM]);

  const { events } = await calendar().events(USER, {});

  expect(roomLinks.resolve).toHaveBeenCalledWith(USER, [CODE]);
  expect(events[0].room).toEqual(ROOM);
});

it('reads the description when the location holds no link', async () => {
  fetch.mockResolvedValue(
    answer(200, {
      items: [
        {
          ...standup,
          location: 'Room 2',
          description: `Join us at ${APP_URL}/join/${CODE} for class`,
        },
      ],
    }),
  );
  roomLinks.resolve.mockResolvedValue([ROOM]);

  const { events } = await calendar().events(USER, {});

  expect(events[0].room).toEqual(ROOM);
});

it('leaves room null for a link the member may not open', async () => {
  fetch.mockResolvedValue(
    answer(200, {
      items: [{ ...standup, location: `${APP_URL}/join/${CODE}` }],
    }),
  );

  const { events } = await calendar().events(USER, {});

  expect(events[0].room).toBeNull();
});

it('looks every code up at once, after the read', async () => {
  const other = 'Zz9Yy8Xx7W';
  fetch.mockResolvedValue(
    answer(200, {
      items: [
        { ...standup, id: 'a', location: `${APP_URL}/join/${CODE}` },
        { ...standup, id: 'b' },
        { ...standup, id: 'c', description: `${APP_URL}/join/${other}` },
      ],
    }),
  );
  roomLinks.resolve.mockResolvedValue([ROOM]);

  const { events } = await calendar().events(USER, {});

  expect(roomLinks.resolve).toHaveBeenCalledTimes(1);
  expect(roomLinks.resolve).toHaveBeenCalledWith(USER, [CODE, other]);
  expect(events.map((e) => e.room)).toEqual([ROOM, null, null]);
});

it('does not look anything up when no event holds a link', async () => {
  fetch.mockResolvedValue(answer(200, { items: [standup] }));

  await calendar().events(USER, {});

  expect(roomLinks.resolve).not.toHaveBeenCalled();
});

it('still answers, without rooms, when the lookup fails', async () => {
  fetch.mockResolvedValue(
    answer(200, {
      items: [{ ...standup, location: `${APP_URL}/join/${CODE}` }],
    }),
  );
  roomLinks.resolve.mockRejectedValue(new Error('database down'));

  const result = await calendar().events(USER, {});

  expect(result.connected).toBe(true);
  expect(result.events[0].room).toBeNull();
  expect(logger.error).toHaveBeenCalled();
});

describe('the room link event running now', () => {
  const NOW = new Date('2026-11-05T09:55:00Z');
  const linked = (over: Record<string, unknown> = {}) => ({
    status: 'confirmed',
    description: `Join at ${APP_URL}/join/${CODE}`,
    organizer: { self: true },
    start: { dateTime: '2026-11-05T10:00:00Z' },
    end: { dateTime: '2026-11-05T11:00:00Z' },
    ...over,
  });

  it('reads the maker’s events running in the next ten minutes, and takes their own carrying the link', async () => {
    fetch.mockResolvedValue(
      answer(200, {
        items: [
          linked({ organizer: { self: false } }),
          linked({ description: `${APP_URL}/join/a0therC0de` }),
          linked({
            start: { date: '2026-11-05' },
            end: { date: '2026-11-06' },
          }),
          linked({ start: { dateTime: '2026-11-05T10:05:00Z' } }),
        ],
      }),
    );

    await expect(
      calendar().runningRoomLinkEvent('maker-1', CODE, NOW),
    ).resolves.toEqual({
      startsAt: new Date('2026-11-05T10:05:00Z'),
      endsAt: new Date('2026-11-05T11:00:00Z'),
    });
    expect(grants.find).toHaveBeenCalledWith('maker-1');
    const [url] = fetch.mock.calls[0] as [URL];
    expect(url.searchParams.get('timeMin')).toBe('2026-11-05T09:55:00.000Z');
    expect(url.searchParams.get('timeMax')).toBe('2026-11-05T10:05:00.001Z');
    expect(url.searchParams.get('singleEvents')).toBe('true');
    expect(url.searchParams.get('fields')).toContain('organizer(self)');
  });

  it('finds nothing when none of theirs carries it', async () => {
    fetch.mockResolvedValue(
      answer(200, { items: [linked({ organizer: { self: false } })] }),
    );

    await expect(
      calendar().runningRoomLinkEvent('maker-1', CODE, NOW),
    ).resolves.toBeNull();
  });

  it('leaves the window be when the maker has no calendar, or Google fails', async () => {
    grants.find.mockResolvedValueOnce(null);
    await expect(
      calendar().runningRoomLinkEvent('maker-1', CODE, NOW),
    ).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();

    fetch.mockResolvedValue(answer(500, 'backend error'));
    await expect(
      calendar().runningRoomLinkEvent('maker-1', CODE, NOW),
    ).resolves.toBeNull();
  });

  it('finds nothing where the calendar is switched off', async () => {
    grants.find.mockRejectedValueOnce(new CalendarNotConfiguredError());

    await expect(
      calendar().runningRoomLinkEvent('maker-1', CODE, NOW),
    ).resolves.toBeNull();
  });

  it('forgets a grant Google has withdrawn', async () => {
    fetch.mockResolvedValue(
      answer(403, {
        error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] },
      }),
    );

    await expect(
      calendar().runningRoomLinkEvent('maker-1', CODE, NOW),
    ).resolves.toBeNull();
    expect(grants.forget).toHaveBeenCalledWith(GRANT);
  });
});
