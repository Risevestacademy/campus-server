import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import type { PaginatedResponseDto } from '../../shared/dto/index.js';
import { SessionGuard } from '../auth/session.guard.js';
import {
  ApiListNotifications,
  ApiMarkAllNotificationsRead,
  ApiMarkNotificationRead,
} from './docs/notifications.docs.js';
import {
  ListNotificationsQueryDto,
  type MarkAllReadResponseDto,
  type NotificationDto,
  NotificationIdParamDto,
} from './dto/notification.dto.js';
import { NotificationsService } from './notifications.service.js';

/** Only ever the signed-in member's own: no route takes a recipient. */
@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiListNotifications()
  list(
    @CurrentUser() member: AuthenticatedUser,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<PaginatedResponseDto<NotificationDto>> {
    return this.notifications.list(member.id, query);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiMarkAllNotificationsRead()
  markAllRead(
    @CurrentUser() member: AuthenticatedUser,
  ): Promise<MarkAllReadResponseDto> {
    return this.notifications.markAllRead(member.id);
  }

  @Patch(':id/read')
  @ApiMarkNotificationRead()
  markRead(
    @CurrentUser() member: AuthenticatedUser,
    @Param() params: NotificationIdParamDto,
  ): Promise<NotificationDto> {
    return this.notifications.markRead(member.id, params.id);
  }
}
