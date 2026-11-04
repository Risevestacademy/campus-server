import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { RoomLinkDto } from '../dto/room-link.dto.js';

const noSession = ApiUnauthorizedResponse({
  type: ApiErrorResponseDto,
  description: 'No usable full-access session.',
});

const notStaff = ApiForbiddenResponse({
  type: ApiErrorResponseDto,
  description:
    'The caller is not an admin, nor a professor or mentor with a live place in this cohort.',
});

const noSpace = ApiNotFoundResponse({
  type: ApiErrorResponseDto,
  description:
    'No space with that id is set up on the entry map (retired, no kind yet, ' +
    "a map's corridors, or on another map), " +
    'or (admins) no such cohort.',
});

export function ApiCreateRoomLink(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Make a room link for an event',
      description:
        "A short link to the space in this cohort's campus, named for one " +
        'event. A space may have any number of live links. Paste `url` ' +
        'into the calendar event.\n\n' +
        "For admins, and for the cohort's live professors and mentors.",
    }),
    ApiCreatedResponse({ type: RoomLinkDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        'An id is not a UUID, or the title is blank or over 128 characters.',
    }),
    noSession,
    notStaff,
    noSpace,
  );
}

export function ApiListRoomLinks(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: "List a space's room links",
      description:
        "The space's live links in this cohort, newest first. Revoked " +
        'links are left out.\n\n' +
        "For admins, and for the cohort's live professors and mentors.",
    }),
    ApiOkResponse({ type: [RoomLinkDto] }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'An id is not a UUID.',
    }),
    noSession,
    notStaff,
    noSpace,
  );
}

export function ApiOpenRoomLink(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Open a room link',
      description:
        'Which cohort and space a link leads to, and the event it was made ' +
        'for. Opening it does not let anybody into the space: world still ' +
        'decides that.\n\n' +
        'For anybody with a live place in the cohort, and for admins.',
    }),
    ApiOkResponse({ type: RoomLinkDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'The code is not ten letters and digits.',
    }),
    noSession,
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description:
        'No such link, it was revoked, its space is no longer set up on ' +
        'the entry map, or the caller holds no live place in its cohort.',
    }),
  );
}

export function ApiRevokeRoomLink(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Revoke a room link',
      description:
        'The link stops opening. Revoking one already revoked changes ' +
        "nothing.\n\nFor admins, and for the cohort's live professors and " +
        'mentors.',
    }),
    ApiNoContentResponse({ description: 'Revoked.' }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'The code is not ten letters and digits.',
    }),
    noSession,
    ApiForbiddenResponse({
      type: ApiErrorResponseDto,
      description: 'The caller is a member of the cohort, but not staff.',
    }),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description:
        'No such link, or the caller holds no live place in its cohort.',
    }),
  );
}
