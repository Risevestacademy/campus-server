import type { PinoLogger } from 'nestjs-pino';

import type { CalendarChannelsService } from './calendar-channels.service.js';
import { CalendarNotificationsController } from './calendar-notifications.controller.js';
import type { CalendarSyncService } from './calendar-sync.service.js';

const channels = { verify: vi.fn() };
const sync = { sync: vi.fn() };
const logger = { error: vi.fn(), setContext: vi.fn() };
const controller = new CalendarNotificationsController(
  channels as unknown as CalendarChannelsService,
  sync as unknown as CalendarSyncService,
  logger as unknown as PinoLogger,
);

beforeEach(() => {
  vi.resetAllMocks();
  sync.sync.mockResolvedValue(undefined);
});

it('syncs the calendar a genuine change is about', async () => {
  channels.verify.mockResolvedValue('user-1');

  await controller.notify('channel', 'token', 'exists');

  expect(channels.verify).toHaveBeenCalledWith('channel', 'token');
  expect(sync.sync).toHaveBeenCalledWith('user-1');
});

it('ignores the channel’s opening message', async () => {
  channels.verify.mockResolvedValue('user-1');

  await controller.notify('channel', 'token', 'sync');

  expect(sync.sync).not.toHaveBeenCalled();
});

it('ignores a notification that is not ours', async () => {
  channels.verify.mockResolvedValue(null);

  await controller.notify('channel', 'wrong', 'exists');

  expect(sync.sync).not.toHaveBeenCalled();
});

it('answers before the sync ends, and logs one that fails', async () => {
  channels.verify.mockResolvedValue('user-1');
  sync.sync.mockRejectedValue(new Error('google down'));

  await expect(
    controller.notify('channel', 'token', 'exists'),
  ).resolves.toBeUndefined();
  await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());
});
