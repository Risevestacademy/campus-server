import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { ApiPaginatedResponse } from '../../../shared/dto/index.js';
import {
  MarkAllReadResponseDto,
  NotificationDto,
} from '../dto/notification.dto.js';

const unauthorized = ApiUnauthorizedResponse({
  type: ApiErrorResponseDto,
  description: 'No usable full-access session.',
});

export function ApiListNotifications(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'List your notifications',
      description:
        'Your own, newest first, paginated. `unread=true` leaves out the ' +
        'ones already read, which is the badge count in `meta.total`.\n\n' +
        'Each says what happened (`kind`) and what it is about ' +
        '(`referenceType`, `referenceId`), and not the thing itself: fetch ' +
        'the notice when you need its text.\n\n' +
        'New ones also arrive, while a campus socket is open, as world’s ' +
        '`notification` message, with the same fields.',
    }),
    ApiPaginatedResponse(NotificationDto),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: '`unread` is not true or false, or a page is out of range.',
    }),
    unauthorized,
  );
}

export function ApiMarkNotificationRead(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Mark one notification read',
      description:
        'Answers the notification as it now is. One already read is ' +
        'answered as it is, and changes nothing.',
    }),
    ApiOkResponse({ type: NotificationDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'The id is not a UUID.',
    }),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No notification of yours has this id.',
    }),
    unauthorized,
  );
}

export function ApiMarkAllNotificationsRead(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Mark all your notifications read',
      description:
        'Every one of yours not yet read, for "clear all". Answers how many ' +
        'that was; none is not an error.',
    }),
    ApiOkResponse({ type: MarkAllReadResponseDto }),
    unauthorized,
  );
}
