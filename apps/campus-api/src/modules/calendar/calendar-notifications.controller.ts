import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { PinoLogger } from 'nestjs-pino';

import { CalendarChannelsService } from './calendar-channels.service.js';
import { CalendarSyncService } from './calendar-sync.service.js';
import { ApiCalendarNotification } from './docs/calendar.docs.js';

/** Google's push notifications. They carry no body: each one means "sync". */
@ApiTags('calendar')
@SkipThrottle()
@Controller('calendar/notifications')
export class CalendarNotificationsController {
  constructor(
    private readonly channels: CalendarChannelsService,
    private readonly sync: CalendarSyncService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CalendarNotificationsController.name);
  }

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCalendarNotification()
  async notify(
    @Headers('x-goog-channel-id') channelId: string | undefined,
    @Headers('x-goog-channel-token') token: string | undefined,
    @Headers('x-goog-resource-state') state: string | undefined,
  ): Promise<void> {
    const userId = await this.channels.verify(channelId, token);
    if (!userId || state !== 'exists') {
      return;
    }
    this.sync
      .sync(userId)
      .catch((err: unknown) =>
        this.logger.error({ err, userId }, 'calendar sync failed'),
      );
  }
}
