import { Module } from '@nestjs/common';

import { fetchWithTimeout } from '../../shared/http/fetch-with-timeout.js';
import { SessionModule } from '../auth/session.module.js';
import { CalendarGrantsService } from './calendar-grants.service.js';
import { CalendarStateService } from './calendar-state.service.js';
import { CalendarController } from './calendar.controller.js';
import { GoogleCalendarClient } from './google-calendar.client.js';
import {
  CALENDAR_FETCH,
  GoogleCalendarService,
} from './google-calendar.service.js';

@Module({
  // SessionModule for the guard, and for UsersService through it.
  imports: [SessionModule],
  controllers: [CalendarController],
  providers: [
    CalendarGrantsService,
    CalendarStateService,
    GoogleCalendarClient,
    GoogleCalendarService,
    { provide: CALENDAR_FETCH, useValue: fetchWithTimeout },
  ],
})
export class CalendarModule {}
