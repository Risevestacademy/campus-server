import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
} from '@nestjs/swagger';

import { ApiAdminOnly } from '../../../shared/dto/admin-route.docs.js';
import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import {
  AttendanceReportDto,
  MembershipReportDto,
} from '../dto/reports.dto.js';

const CSV =
  '\n\nWith `format=csv` the same rows come as a CSV download ' +
  '(`text/csv`, UTF-8 with a byte-order mark, snake_case headers, ' +
  '`Content-Disposition: attachment`), and the download is recorded in ' +
  'the audit log as `report_exported`. A text cell a spreadsheet would run ' +
  "as a formula starts with `'`.";

export function ApiMembershipReport(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Membership report for a cohort (admin only)',
      description:
        'Every membership of the cohort, whole rather than paged: who, their ' +
        'role, track and student status, whether it counts now, when it ' +
        'began and ended, why an admin ended it, and when a guest’s visit ' +
        'runs out. `state` defaults to `all`, so people who left are in it; ' +
        '`state`, `role` and `trackId` filter as they do on the roster, in ' +
        'the roster’s order.' +
        CSV,
    }),
    ApiProduces('application/json', 'text/csv'),
    ApiOkResponse({ type: MembershipReportDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'A filter or `format` is not one this route knows.',
    }),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No cohort has that id.',
    }),
    ApiAdminOnly(),
  );
}

export function ApiAttendanceReport(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Attendance report for a cohort (admin only)',
      description:
        'Per student, over the tallied classes that started in ' +
        '[`from`, `to`): classes expected at, present, partial, absent, how ' +
        'many statuses staff corrected, time in the call against the time ' +
        'there was, and the percentage the attendance reads give. Every ' +
        'student the cohort has had is a row, so one expected at nothing in ' +
        'the range shows with zeros and a null percentage. Anybody no longer ' +
        'a student who has rows keeps them. `state` defaults to `all`; ' +
        '`state` and `trackId` filter by the membership as it is now, as on ' +
        'the roster. Ordered by name.' +
        CSV,
    }),
    ApiProduces('application/json', 'text/csv'),
    ApiOkResponse({ type: AttendanceReportDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        'A filter or `format` is not one this route knows, or `from` is not ' +
        'before `to`.',
    }),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No cohort has that id.',
    }),
    ApiAdminOnly(),
  );
}
