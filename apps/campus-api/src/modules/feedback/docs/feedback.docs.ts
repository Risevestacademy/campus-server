import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ApiAdminOnly } from '../../../shared/dto/admin-route.docs.js';
import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { ApiPaginatedResponse } from '../../../shared/dto/index.js';
import {
  FeedbackDto,
  FeedbackListItemDto,
  FeedbackReceiptDto,
} from '../dto/feedback.dto.js';

const notFound = ApiNotFoundResponse({
  type: ApiErrorResponseDto,
  description:
    'No feedback has this id, or it is a report that names the admin asking.',
});

export function ApiSendFeedback(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Send feedback',
      description:
        'For any signed-in member: a `bug` (something is broken), an ' +
        '`idea` (something could be better) or a `report` (somebody did ' +
        'something they should not have).\n\n' +
        '`title` and `details` are required. `about` is the "who or ' +
        'where" line, offered on every type and required on none: who a ' +
        'report is about, where a bug happened.\n\n' +
        'Who sent it is taken from the session and cannot be set. ' +
        '`context` and `cohortId` are for the client to fill in, not the ' +
        'member: where they were when they sent it. `cohortId` has to be ' +
        'a cohort the sender is in.\n\n' +
        'A `report` may also name an account with `reportedUserId`. That ' +
        'person is not told, and nobody but an admin can read what was ' +
        'sent. Admins are emailed that a report has arrived, without what ' +
        'it says; an admin the report names is left out, and cannot read ' +
        'or resolve it.\n\n' +
        'The answer confirms it arrived. A member cannot read back what ' +
        'they have sent.',
    }),
    ApiCreatedResponse({ type: FeedbackReceiptDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        'A field is missing, blank or too long; `type` is not one of the ' +
        'three; `reportedUserId` is on something that is not a report or ' +
        'names no account; `cohortId` is not a cohort the sender is in; or ' +
        '`context` is not one object.',
    }),
    ApiUnauthorizedResponse({
      type: ApiErrorResponseDto,
      description: 'No usable full-access session.',
    }),
    ApiTooManyRequestsResponse({
      type: ApiErrorResponseDto,
      description:
        'This account has sent ten in the last hour. Counted per account, ' +
        'whatever the type.',
      content: {
        'application/json': {
          examples: {
            limited: {
              summary: 'Too much in the last hour',
              value: {
                error: {
                  code: 'RATE_LIMITED',
                  message:
                    'You have sent a lot of feedback in the last hour. Try again later.',
                },
              },
            },
          },
        },
      },
    }),
  );
}

export function ApiListFeedback(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'List feedback (admin only)',
      description:
        'Everything members have sent, newest first, paginated. Filters ' +
        'are optional and combine with AND: `type`, `status`, and ' +
        '`submittedBy` for everything one account has sent.\n\n' +
        'Each row has who sent it and, for a report that names an ' +
        'account, who it names. The `details` are on the single read.\n\n' +
        'A report that names the admin asking is left out, and not ' +
        'counted.',
    }),
    ApiPaginatedResponse(FeedbackListItemDto),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'A filter is not one of its values, or not a UUID.',
    }),
    ApiAdminOnly(),
  );
}

export function ApiGetFeedback(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Read one piece of feedback (admin only)',
      description:
        'The whole of it: what was written, who sent it, where their ' +
        'client said they were, and who resolved it if anybody has.\n\n' +
        '`context` and `userAgent` are what the sender’s client reported, ' +
        'and are checked against nothing.',
    }),
    ApiOkResponse({ type: FeedbackDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'The id is not a UUID.',
    }),
    ApiAdminOnly(),
    notFound,
  );
}

export function ApiSetFeedbackStatus(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Resolve or reopen feedback (admin only)',
      description:
        'Marks a piece of feedback `resolved`, recording who did it and ' +
        'when, or puts it back to `open`, which clears both.\n\n' +
        'Setting the status it already has changes nothing and records ' +
        'nothing. A change writes an audit entry naming the admin and the ' +
        'feedback, and nothing of what the feedback says.',
    }),
    ApiOkResponse({ type: FeedbackDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'The id is not a UUID, or `status` is not one of the two.',
    }),
    ApiAdminOnly(),
    notFound,
  );
}
