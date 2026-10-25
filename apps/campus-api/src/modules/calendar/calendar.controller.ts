import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import {
  CalendarConnectRedirectFilter,
  calendarReturnUrl,
} from './calendar-connect-redirect.filter.js';
import {
  ApiCalendarEvents,
  ApiConnectCalendar,
  ApiConnectCalendarCallback,
  ApiConnectCalendarFromApp,
  ApiDisconnectCalendar,
} from './docs/calendar.docs.js';
import {
  CalendarAppConnectDto,
  CalendarCallbackQueryDto,
} from './dto/calendar-connect.dto.js';
import {
  CalendarEventsQueryDto,
  type CalendarEventsDto,
} from './dto/calendar-events.dto.js';
import { GoogleCalendarService } from './google-calendar.service.js';

@ApiTags('calendar')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('calendar')
export class CalendarController {
  constructor(
    private readonly calendar: GoogleCalendarService,
    @Inject(CONFIG) private readonly config: Env,
  ) {}

  @Get('connect')
  @UseFilters(CalendarConnectRedirectFilter)
  @ApiConnectCalendar()
  connect(@CurrentUser() user: AuthenticatedUser, @Res() res: Response): void {
    res.redirect(this.calendar.connectUrl(user));
  }

  @Get('connect/callback')
  @UseFilters(CalendarConnectRedirectFilter)
  @ApiConnectCalendarCallback()
  async callback(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CalendarCallbackQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.calendar.completeConnect(user.id, query);
    res.redirect(calendarReturnUrl(this.config, 'connected'));
  }

  @Post('connect')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiConnectCalendarFromApp()
  connectFromApp(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CalendarAppConnectDto,
  ): Promise<void> {
    return this.calendar.connectWithAppCode(user.id, dto.serverAuthCode);
  }

  @Get('events')
  @ApiCalendarEvents()
  events(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CalendarEventsQueryDto,
  ): Promise<CalendarEventsDto> {
    return this.calendar.events(user.id, query);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiDisconnectCalendar()
  disconnect(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.calendar.disconnect(user.id);
  }
}
