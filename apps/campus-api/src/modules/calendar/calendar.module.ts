import { Module } from '@nestjs/common';

import { fetchWithTimeout } from '../../shared/http/fetch-with-timeout.js';
import { SessionModule } from '../auth/session.module.js';
import { AccessTokenCache } from './access-token-cache.js';
import { CalendarConnectService } from './calendar-connect.service.js';
import { CalendarEventsService } from './calendar-events.service.js';
import { CalendarGrantsService } from './calendar-grants.service.js';
import { CalendarRevocationService } from './calendar-revocation.service.js';
import { CalendarStateService } from './calendar-state.service.js';
import { CalendarController } from './calendar.controller.js';
import {
  CALENDAR_FETCH,
  GoogleCalendarClient,
} from './google-calendar.client.js';

@Module({
  // SessionModule for the guard, and for UsersService through it.
  imports: [SessionModule],
  controllers: [CalendarController],
  providers: [
    AccessTokenCache,
    CalendarConnectService,
    CalendarEventsService,
    CalendarGrantsService,
    CalendarRevocationService,
    CalendarStateService,
    GoogleCalendarClient,
    { provide: CALENDAR_FETCH, useValue: fetchWithTimeout },
  ],
})
export class CalendarModule {}
