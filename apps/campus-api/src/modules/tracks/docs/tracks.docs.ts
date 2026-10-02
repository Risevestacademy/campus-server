import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';

import { ApiAdminOnly } from '../../../shared/dto/admin-route.docs.js';
import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { ApiPaginatedResponse } from '../../../shared/dto/index.js';
import { TrackResponseDto } from '../dto/track-response.dto.js';

export function ApiCreateTrack(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Create a track (admin only)',
      description:
        'Adds a programme to the catalogue. A track belongs to no cohort ' +
        'until it is attached to one with POST /v1/cohorts/{id}/tracks. ' +
        'code is trimmed and uppercased, and must be unique.',
    }),
    ApiCreatedResponse({ type: TrackResponseDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'A missing or malformed field.',
    }),
    ApiAdminOnly(),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description: 'Another track already has this code.',
      content: {
        'application/json': {
          examples: {
            duplicateCode: {
              summary: 'Code taken',
              value: {
                error: {
                  code: 'CONFLICT',
                  message: 'A track with code SE already exists',
                  details: { code: 'SE' },
                },
              },
            },
          },
        },
      },
    }),
  );
}

export function ApiListTracks(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'List tracks (admin only)',
      description: 'Every track in the catalogue, by name.',
    }),
    ApiPaginatedResponse(TrackResponseDto),
    ApiAdminOnly(),
  );
}

const trackNotFound = {
  summary: 'No such track',
  value: {
    error: {
      code: 'NOT_FOUND',
      message: 'Track 33333333-3333-4333-8333-333333333333 not found',
      details: { trackId: '33333333-3333-4333-8333-333333333333' },
    },
  },
};

export function ApiUpdateTrack(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Update a track (admin only)',
      description:
        'A partial edit: only the fields present are written. code is ' +
        'trimmed and uppercased, and must be unique. An empty description ' +
        'clears it.',
    }),
    ApiOkResponse({ type: TrackResponseDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'A malformed field, or id is not a UUID.',
    }),
    ApiAdminOnly(),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No track has this id.',
      content: { 'application/json': { examples: { trackNotFound } } },
    }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description: 'Another track already has this code.',
      content: {
        'application/json': {
          examples: {
            duplicateCode: {
              summary: 'Code taken',
              value: {
                error: {
                  code: 'CONFLICT',
                  message: 'A track with code SE already exists',
                  details: { code: 'SE' },
                },
              },
            },
          },
        },
      },
    }),
  );
}

export function ApiDeleteTrack(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Delete a track (admin only)',
      description:
        'Removes a catalogue track no cohort runs. A track still attached ' +
        'to cohorts is refused with a 409.',
    }),
    ApiNoContentResponse({ description: 'The track was deleted.' }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'id is not a UUID.',
    }),
    ApiAdminOnly(),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No track has this id.',
      content: { 'application/json': { examples: { trackNotFound } } },
    }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description: 'The track is still attached to cohorts.',
      content: {
        'application/json': {
          examples: {
            stillAttached: {
              summary: 'Track in use',
              value: {
                error: {
                  code: 'CONFLICT',
                  message:
                    'Track cannot be deleted while it is still attached to cohorts',
                  details: { trackId: '33333333-3333-4333-8333-333333333333' },
                },
              },
            },
          },
        },
      },
    }),
  );
}
