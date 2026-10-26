import type { PinoLogger } from 'nestjs-pino';

import type { UsersService } from '../users/users.service.js';
import type { AccessTokenCache } from './access-token-cache.js';
import type { CalendarGrantsService } from './calendar-grants.service.js';
import type { CalendarStateService } from './calendar-state.service.js';
import { CalendarConnectService } from './calendar-connect.service.js';
import { CalendarConnectFailedError } from './calendar.exceptions.js';
import type { GoogleCalendarClient } from './google-calendar.client.js';

const CALENDAR = 'https://www.googleapis.com/auth/calendar.events.readonly';

const grants = { save: vi.fn() };
const google = {
  authorizationUrl: vi.fn(),
  redeemWebCode: vi.fn(),
  redeemAppCode: vi.fn(),
  revoke: vi.fn(),
};
const states = { issue: vi.fn(), verify: vi.fn() };
const tokens = { evict: vi.fn() };
const users = { findById: vi.fn() };
const logger = { info: vi.fn(), setContext: vi.fn() };

const service = new CalendarConnectService(
  grants as unknown as CalendarGrantsService,
  google as unknown as GoogleCalendarClient,
  states as unknown as CalendarStateService,
  tokens as unknown as AccessTokenCache,
  users as unknown as UsersService,
  logger as unknown as PinoLogger,
);

const redeemed = (overrides = {}) => ({
  subject: 'google-sub-1',
  scopes: ['openid', CALENDAR],
  refreshToken: 'new-refresh',
  accessToken: 'new-access',
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  google.redeemWebCode.mockResolvedValue(redeemed());
  google.redeemAppCode.mockResolvedValue(redeemed());
  users.findById.mockResolvedValue({
    id: 'user-1',
    providerId: 'google-sub-1',
  });
});

it('sends the member to Google with a state that names them', () => {
  states.issue.mockReturnValue('the-state');
  google.authorizationUrl.mockReturnValue('https://accounts.google.com/x');

  expect(
    service.connectUrl({ id: 'user-1', email: 'ada@campus.local' } as never),
  ).toBe('https://accounts.google.com/x');
  expect(states.issue).toHaveBeenCalledWith('user-1');
  expect(google.authorizationUrl).toHaveBeenCalledWith(
    'the-state',
    'ada@campus.local',
  );
});

it('keeps the grant Google hands back to the member who asked', async () => {
  await service.completeConnect('user-1', { code: 'c', state: 's' });

  expect(states.verify).toHaveBeenCalledWith('s', 'user-1');
  expect(google.redeemWebCode).toHaveBeenCalledWith('c');
  expect(grants.save).toHaveBeenCalledWith('user-1', 'new-refresh');
  expect(tokens.evict).toHaveBeenCalledWith('user-1');
  expect(google.revoke).not.toHaveBeenCalled();
});

it('checks the state before anything reaches Google', async () => {
  states.verify.mockImplementation(() => {
    throw new CalendarConnectFailedError('invalid_state');
  });

  await expect(
    service.completeConnect('user-1', { code: 'c', state: 's' }),
  ).rejects.toMatchObject({ reason: 'invalid_state' });
  expect(google.redeemWebCode).not.toHaveBeenCalled();
});

it.each([
  [{ state: 's', error: 'access_denied' }, 'denied'],
  [{ state: 's' }, 'missing_code'],
])('reports %o as %s', async (query, reason) => {
  await expect(service.completeConnect('user-1', query)).rejects.toMatchObject({
    reason,
  });
  expect(google.redeemWebCode).not.toHaveBeenCalled();
});

it('redeems a native app’s code as the app’s', async () => {
  await service.connectWithAppCode('user-1', 'server-code');

  expect(google.redeemAppCode).toHaveBeenCalledWith('server-code');
  expect(grants.save).toHaveBeenCalledWith('user-1', 'new-refresh');
});

it('refuses, and revokes, another Google account’s calendar', async () => {
  google.redeemAppCode.mockResolvedValue(
    redeemed({ subject: 'somebody-else' }),
  );

  await expect(
    service.connectWithAppCode('user-1', 'server-code'),
  ).rejects.toMatchObject({ reason: 'wrong_account' });
  expect(google.revoke).toHaveBeenCalledWith('new-refresh');
  expect(grants.save).not.toHaveBeenCalled();
});

it('refuses an account that has never signed in with Google', async () => {
  users.findById.mockResolvedValue({ id: 'user-1', providerId: null });

  await expect(
    service.connectWithAppCode('user-1', 'server-code'),
  ).rejects.toMatchObject({ reason: 'wrong_account' });
});

it('refuses a grant without the calendar in it', async () => {
  google.redeemAppCode.mockResolvedValue(redeemed({ scopes: ['openid'] }));

  await expect(
    service.connectWithAppCode('user-1', 'server-code'),
  ).rejects.toMatchObject({ reason: 'not_granted' });
  expect(grants.save).not.toHaveBeenCalled();
});

// Revoking would end the member's whole grant, a working connection too.
it('refuses a code with no refresh token, and revokes nothing', async () => {
  google.redeemAppCode.mockResolvedValue(redeemed({ refreshToken: undefined }));

  await expect(
    service.connectWithAppCode('user-1', 'server-code'),
  ).rejects.toMatchObject({ reason: 'no_refresh_token' });
  expect(google.revoke).not.toHaveBeenCalled();
  expect(grants.save).not.toHaveBeenCalled();
});
