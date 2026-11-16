import type { PinoLogger } from 'nestjs-pino';

import type { Env } from '../../infra/config/config.module.js';
import type { Scheduler } from '../../infra/scheduler/scheduler.js';
import type { CalendarChannelsService } from './calendar-channels.service.js';
import type { CalendarGrantsService } from './calendar-grants.service.js';
import type { CalendarRevocationService } from './calendar-revocation.service.js';
import type { CalendarSyncService } from './calendar-sync.service.js';
import { BACKSTOP_MS, CalendarWatchService } from './calendar-watch.service.js';

const NOW = new Date('2026-11-09T08:00:00Z');
const grant = { userId: 'user-1', refreshToken: 'r', sealed: 's' };

const scheduler = { register: vi.fn() };
const grants = { watchable: vi.fn(), find: vi.fn() };
const channels = { ensure: vi.fn(), stopAll: vi.fn() };
const sync = {
  managesRoomLinks: vi.fn(),
  sync: vi.fn(),
  reconcile: vi.fn(),
};
const revocations = { sweep: vi.fn() };
const logger = { error: vi.fn(), setContext: vi.fn() };

const watch = (enabled = true) =>
  new CalendarWatchService(
    { FF_GOOGLE_CALENDAR_ENABLED: enabled } as Env,
    scheduler as unknown as Scheduler,
    grants as unknown as CalendarGrantsService,
    channels as unknown as CalendarChannelsService,
    sync as unknown as CalendarSyncService,
    revocations as unknown as CalendarRevocationService,
    logger as unknown as PinoLogger,
  );

beforeEach(() => {
  vi.resetAllMocks();
  grants.find.mockResolvedValue(grant);
  sync.managesRoomLinks.mockResolvedValue(true);
});

it('registers the sync and the revocation sweep with the scheduler', () => {
  watch().onModuleInit();

  expect(scheduler.register.mock.calls.map(([job]) => job.name)).toEqual([
    'calendar-revocations',
    'calendar-sync',
  ]);
});

describe('watchAll', () => {
  it('keeps every channel open, and syncs only calendars due the backstop', async () => {
    grants.watchable.mockResolvedValue([
      { userId: 'never', syncedAt: null },
      { userId: 'stale', syncedAt: new Date(NOW.getTime() - BACKSTOP_MS) },
      { userId: 'fresh', syncedAt: new Date(NOW.getTime() - 60_000) },
    ]);

    await watch().watchAll(NOW);

    expect(channels.ensure).toHaveBeenCalledTimes(3);
    expect(sync.sync.mock.calls.map(([userId]) => userId).sort()).toEqual([
      'never',
      'stale',
    ]);
  });

  it('reconciles every run to come first', async () => {
    grants.watchable.mockResolvedValue([]);

    await watch().watchAll(NOW);

    expect(sync.reconcile).toHaveBeenCalledWith(NOW);
  });

  it('still syncs a calendar whose channel could not be opened', async () => {
    grants.watchable.mockResolvedValue([{ userId: 'user-1', syncedAt: null }]);
    channels.ensure.mockRejectedValue(new Error('push refused'));

    await watch().watchAll(NOW);

    expect(sync.sync).toHaveBeenCalledWith('user-1', NOW);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('stops watching somebody who no longer manages room links', async () => {
    grants.watchable.mockResolvedValue([{ userId: 'user-1', syncedAt: null }]);
    sync.managesRoomLinks.mockResolvedValue(false);

    await watch().watchAll(NOW);

    expect(channels.stopAll).toHaveBeenCalledWith(grant);
    expect(channels.ensure).not.toHaveBeenCalled();
    expect(sync.sync).not.toHaveBeenCalled();
  });

  it('carries on past a calendar that fails', async () => {
    grants.watchable.mockResolvedValue([
      { userId: 'a', syncedAt: null },
      { userId: 'b', syncedAt: null },
    ]);
    grants.find.mockImplementation((userId: string) =>
      Promise.resolve({ ...grant, userId }),
    );
    sync.sync.mockImplementation((userId: string) =>
      userId === 'a'
        ? Promise.reject(new Error('google down'))
        : Promise.resolve(),
    );

    await watch().watchAll(NOW);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(sync.sync).toHaveBeenCalledWith('b', NOW);
  });

  it('does nothing while the calendar is switched off', async () => {
    await watch(false).watchAll(NOW);

    expect(grants.watchable).not.toHaveBeenCalled();
  });
});

it('watches and syncs a calendar as soon as it is connected', async () => {
  watch().afterConnect('user-1');

  await vi.waitFor(() => expect(sync.sync).toHaveBeenCalled());
  expect(channels.ensure).toHaveBeenCalledWith(grant, expect.any(Date));
});
