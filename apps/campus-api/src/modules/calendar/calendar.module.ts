import { Module } from '@nestjs/common';

import { fetchWithTimeout } from '../../shared/http/fetch-with-timeout.js';
import { SessionModule } from '../auth/session.module.js';
import { RoomLinksModule } from '../room-links/room-links.module.js';
import { AccessTokenCache } from './access-token-cache.js';
import { CalendarChannelsService } from './calendar-channels.service.js';
import { CalendarConnectService } from './calendar-connect.service.js';
import { CalendarEventsService } from './calendar-events.service.js';
import { CalendarGrantsService } from './calendar-grants.service.js';
import { CalendarRevocationService } from './calendar-revocation.service.js';
import { CalendarNotificationsController } from './calendar-notifications.controller.js';
import { CalendarStateService } from './calendar-state.service.js';
import { CalendarSyncService } from './calendar-sync.service.js';
import { CalendarWatchService } from './calendar-watch.service.js';
import { CalendarController } from './calendar.controller.js';
import { GoogleCalendarApi } from './google-calendar-api.js';
import {
  CALENDAR_FETCH,
  GoogleCalendarClient,
} from './google-calendar.client.js';

@Module({
  imports: [SessionModule, RoomLinksModule],
  controllers: [CalendarController, CalendarNotificationsController],
  providers: [
    AccessTokenCache,
    CalendarChannelsService,
    CalendarConnectService,
    CalendarEventsService,
    CalendarGrantsService,
    CalendarRevocationService,
    CalendarStateService,
    CalendarSyncService,
    CalendarWatchService,
    GoogleCalendarApi,
    GoogleCalendarClient,
    { provide: CALENDAR_FETCH, useValue: fetchWithTimeout },
  ],
})
export class CalendarModule {}
