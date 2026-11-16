import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { ApiPaginatedResponse } from '../../../shared/dto/paginated-response.dto.js';
import {
  AttendanceClassDetailDto,
  AttendanceClassDto,
  AttendanceRowDto,
  StudentAttendanceDto,
  StudentAttendanceSummaryDto,
} from '../dto/attendance.dto.js';

const WHO =
  'Admins see every class of the cohort. A professor sees the classes aimed at ' +
  'their track, a mentor those aimed at their pod; whole-cohort classes are ' +
  'for admins only.';

const noSession = ApiUnauthorizedResponse({
  type: ApiErrorResponseDto,
  description: 'No usable full-access session.',
});

const forbidden = ApiForbiddenResponse({
  type: ApiErrorResponseDto,
  description:
    'Not an admin, nor a live professor on a track or a mentor of a pod in ' +
    "this cohort; or the class is not aimed at the caller's track or pod.",
});

const badId = ApiBadRequestResponse({
  type: ApiErrorResponseDto,
  description: 'An id is not a UUID.',
});

export function ApiListAttendanceClasses(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: "List a cohort's tallied classes",
      description:
        'Each run of a room link that has been tallied, newest first, with ' +
        'how many students were present, partial and absent. ' +
        WHO,
    }),
    ApiPaginatedResponse(AttendanceClassDto),
    badId,
    noSession,
    forbidden,
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: '(Admins) no such cohort.',
    }),
  );
}

export function ApiGetAttendanceClass(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Read one class',
      description:
        'One tallied run with every expected student: time in the call, ' +
        'percentage, status and whether staff corrected it. ' +
        WHO,
    }),
    ApiOkResponse({ type: AttendanceClassDetailDto }),
    badId,
    noSession,
    forbidden,
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No tallied class with that id.',
    }),
  );
}

export function ApiListStudentAttendance(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: "Summarise a cohort's students",
      description:
        'Per student, across the classes the caller may read: how many, how ' +
        'many present, partial and absent, and the percentage of time. ' +
        WHO,
    }),
    ApiOkResponse({ type: [StudentAttendanceSummaryDto] }),
    badId,
    noSession,
    forbidden,
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: '(Admins) no such cohort.',
    }),
  );
}

export function ApiGetStudentAttendance(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: "Read one student's attendance",
      description:
        "A student's summary and each class, newest first. Students read " +
        'their own, every class. ' +
        WHO,
    }),
    ApiOkResponse({ type: StudentAttendanceDto }),
    badId,
    noSession,
    forbidden,
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: '(Admins) no such cohort.',
    }),
  );
}

export function ApiCorrectAttendance(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: "Correct a student's status at one class",
      description:
        'Sets the status and keeps the correction, with who made it and why, ' +
        'for good. The tally then leaves the status alone, while still ' +
        'measuring the time. ' +
        WHO,
    }),
    ApiOkResponse({ type: AttendanceRowDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        'An id is not a UUID, the status is unknown, the reason is blank or ' +
        'over 500 characters, or the row already has that status.',
    }),
    noSession,
    forbidden,
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No attendance row with that id.',
    }),
  );
}
