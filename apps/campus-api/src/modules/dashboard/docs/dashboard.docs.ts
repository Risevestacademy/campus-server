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
        'A suspended account still counts as a member, as it does on the ' +
        'roster, though world never lets it in: so members can include ' +
        'people who can never show as online.\n\n' +
        'Who is online now is not here: world answers that, at ' +
        '`GET /admin/online`, taking `cohortId` too. For a cohort that does ' +
        'not exist this route answers 404, while world, which does not ' +
        'know which cohorts exist, answers `{ "online": 0 }`.',
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
