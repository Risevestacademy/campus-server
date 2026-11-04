import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { ApiPaginatedResponse } from '../../../shared/dto/paginated-response.dto.js';
import { NoticeCommentDto } from '../dto/notice-comment.dto.js';
import { NoticeResponseDto } from '../dto/notice-response.dto.js';

const noSession = ApiUnauthorizedResponse({
  type: ApiErrorResponseDto,
  description: 'No usable full-access session.',
});

const notVisible = ApiNotFoundResponse({
  type: ApiErrorResponseDto,
  description:
    'No such notice, or one the caller may not see. Both are the same ' +
    'answer, so existence does not leak.',
});

export function ApiListNotices(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'List the notice wall',
      description:
        'The notices the caller can see, pinned first, then newest, with ' +
        'the id breaking ties. The whole result is ordered before it is ' +
        'paged, so pages are stable.\n\n' +
        'A member sees campus notices, notices for their live cohorts, and ' +
        'notices for their exact cohort tracks. Admins see every notice. ' +
        'The filters only narrow that set.',
    }),
    ApiPaginatedResponse(NoticeResponseDto),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'A page, perPage, scope or cohortId is malformed.',
    }),
    noSession,
  );
}

export function ApiListNoticeComments(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'List a notice’s comments',
      description:
        'The comments under one notice, oldest first, with the id breaking ' +
        'ties on the same instant. The notice must be one the caller can see.',
    }),
    ApiPaginatedResponse(NoticeCommentDto),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'The notice id is not a UUID, or paging is malformed.',
    }),
    noSession,
    notVisible,
  );
}

export function ApiAddNoticeComment(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Comment on a notice',
      description:
        'Adds the caller’s comment under a notice they can see. The author ' +
        'comes from the session and the target from the URL; both are ' +
        'ignored in the body. The comment and its audit entry are written ' +
        'together.',
    }),
    ApiCreatedResponse({ type: NoticeCommentDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        'The notice id is not a UUID, or the body is blank or over 2000 ' +
        'characters.',
    }),
    noSession,
    notVisible,
  );
}
