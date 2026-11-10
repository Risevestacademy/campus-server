import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { ApiPaginatedResponse } from '../../../shared/dto/index.js';
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
        'paged, so a pinned notice leads the wall rather than jumping to the ' +
        'top of whichever page it lands on.\n\n' +
        'A member sees campus notices, notices for their live cohorts, ' +
        'notices for their exact cohort tracks, and notices for mentorship ' +
        'groups they belong to. Admins see every notice. The filters only ' +
        'narrow that set; a cohort the caller is not in is an empty page, ' +
        'not an error.\n\n' +
        'Offset pagination: a notice inserted while the caller is walking ' +
        'pages can move an item across a page boundary. A hidden notice ' +
        'never does, because it is not in the visible set or the count.',
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
        'ties on the same instant. The notice must be one the caller can ' +
        'see; an invisible notice and one that does not exist answer the ' +
        'same 404.',
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
        'together, or neither is written.',
    }),
    ApiCreatedResponse({ type: NoticeCommentDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        'The notice id is not a UUID, or the body is blank or over 2000 ' +
        'characters.',
    }),
    ApiTooManyRequestsResponse({
      type: ApiErrorResponseDto,
      description: 'More than 30 comments from one client in a minute.',
    }),
    noSession,
    notVisible,
  );
}
