import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';

import { ApiAdminOnly } from '../../../shared/dto/admin-route.docs.js';
import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { DashboardFiguresDto } from '../dto/dashboard-figures.dto.js';

export function ApiDashboardFigures(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Dashboard figures (admin only)',
      description:
        'Live members, in total and by cohort role, and invites still ' +
        'waiting for an answer: across the campus, or in one cohort with ' +
        '`cohortId`. A live membership has not ended, is an active student ' +
        'or another role, and has not run out (a guest’s visit).\n\n' +
        'Who is online now is not here: world answers that, at ' +
        '`GET /admin/online` with the same `cohortId`.',
    }),
    ApiOkResponse({ type: DashboardFiguresDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: '`cohortId` is not a UUID.',
    }),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No cohort has that id.',
    }),
    ApiAdminOnly(),
  );
}
