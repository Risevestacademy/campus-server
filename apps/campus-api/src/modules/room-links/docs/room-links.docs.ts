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
import { RoomLinkDto, RoomLinkEntryDto } from '../dto/room-link.dto.js';

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
        'into the location or description of a Google Calendar event you ' +
        'organise. Each run of that event is synced from your calendar once ' +
        'you have connected it, and whoever enters through the link from ten ' +
        'minutes before a run starts until it ends may enter the space. A ' +
        'link no synced event carries only shows the way.\n\n' +
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
        'for. Opening it lets nobody into the space; entering it ' +
        '(`POST /room-links/{code}/enter`) does.\n\n' +
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

export function ApiEnterRoomLink(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Enter through a room link',
      description:
        'Call when somebody follows a link, then walk them to `spaceKey` ' +
        "with world's `goToSpace`.\n\n" +
        'While a run of the link is open (from ten minutes before it starts ' +
        'until it ends), the caller may enter the space whenever a run is ' +
        'open, whatever its list says; `admitted` says so, and `startsAt` and ' +
        '`endsAt` are that run. Admins are always admitted.\n\n' +
        'For anybody with a live place in the cohort, and for admins.',
    }),
    ApiOkResponse({ type: RoomLinkEntryDto }),
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
