import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { RecordingDto } from '../dto/recording.dto.js';

const common = [
  ApiBadRequestResponse({
    type: ApiErrorResponseDto,
    description: 'An id is not a UUID.',
  }),
  ApiUnauthorizedResponse({
    type: ApiErrorResponseDto,
    description: 'No usable full-access session.',
  }),
  ApiForbiddenResponse({
    type: ApiErrorResponseDto,
    description:
      "The caller is not an admin, nor one of the cohort's live professors or mentors on the list of this designated space.",
  }),
];

export function ApiStartRecording(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: "Start recording a space's call",
      description:
        "Records the cohort's call in the space as one video of the whole " +
        'room, until it is stopped or the call ends. Everyone in the call is ' +
        'told by LiveKit: the room reports that it is being recorded. ' +
        '`status` is `starting` until LiveKit confirms.\n\n' +
        'For admins, in any space; and for the cohort’s live professors and ' +
        'mentors, in a designated space whose list names them.',
    }),
    ApiCreatedResponse({ type: RecordingDto }),
    ...common,
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No space with that id.',
    }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description:
        'No call is going on in the space, or it is already being recorded.',
    }),
    ApiServiceUnavailableResponse({
      type: ApiErrorResponseDto,
      description:
        'Recording is not configured here, or LiveKit would not start it (for example, the plan’s recording minutes are used up).',
    }),
  );
}

export function ApiStopRecording(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: "Stop recording a space's call",
      description:
        'Stops the recording going on in the space. The video is saved ' +
        'once LiveKit finishes uploading it; `status` turns `complete` then.',
    }),
    ApiOkResponse({ type: RecordingDto }),
    ...common,
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No space with that id, or nothing is being recorded in it.',
    }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description: 'The recording is still starting; try again in a moment.',
    }),
    ApiServiceUnavailableResponse({
      type: ApiErrorResponseDto,
      description: 'Recording is not configured here.',
    }),
  );
}
