import { Module } from '@nestjs/common';

import { SessionModule } from '../auth/session.module.js';
import { CalendarModule } from '../calendar/calendar.module.js';
import { RoomLinkEntryController } from './room-link-entry.controller.js';
import { RoomLinkEntryService } from './room-link-entry.service.js';
import { RoomLinksModule } from './room-links.module.js';

/**
 * Entering through a room link. Apart from RoomLinksModule because it reads
 * the maker's calendar, and the calendar already reads room links.
 */
@Module({
  imports: [SessionModule, RoomLinksModule, CalendarModule],
  controllers: [RoomLinkEntryController],
  providers: [RoomLinkEntryService],
})
export class RoomLinkEntryModule {}
