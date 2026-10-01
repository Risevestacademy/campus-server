import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
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
