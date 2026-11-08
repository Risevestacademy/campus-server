import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CalendarEventsService } from '../calendar/calendar-events.service.js';
import type { RoomLinkEntryDto } from './dto/room-link.dto.js';
import { RoomLinksService } from './room-links.service.js';

@Injectable()
export class RoomLinkEntryService {
  constructor(
    private readonly links: RoomLinksService,
    private readonly calendar: CalendarEventsService,
  ) {}

  /** The window as the maker's calendar has it now, then the way in. */
  async enter(
    user: AuthenticatedUser,
    code: string,
    now: Date = new Date(),
  ): Promise<RoomLinkEntryDto> {
    const entry = await this.links.forEntry(user, code, now);
    const found = await this.calendar.runningRoomLinkEvent(
      entry.createdBy,
      code,
      now,
    );
    return this.links.enter(user, entry, found, now);
  }
}
