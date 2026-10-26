import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';

import { ApiAdminOnly } from '../../../shared/dto/admin-route.docs.js';
import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { ApiPaginatedResponse } from '../../../shared/dto/index.js';
import { MAX_SPACE_CAPACITY, SpaceResponseDto } from '../dto/space.dto.js';

const NO_SPACE = 'No space with that id.';

export function ApiListSpaces(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'List spaces (admin only)',
      description:
        'Every live space, by name. Retired spaces are left out; GET ' +
        '/v1/spaces/{id} still reads one by id.\n\n' +
        '`needsKind=true` narrows the list to spaces with no kind set: the ' +
        'queue of spaces the map drew and no admin has set up yet.',
    }),
    ApiPaginatedResponse(SpaceResponseDto),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'A page or `needsKind` is malformed.',
    }),
    ApiAdminOnly(),
  );
}

export function ApiGetSpace(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Get a space (admin only)',
      description:
        'One space and its settings. A retired space is still readable: ' +
        'retiring keeps the row, and its history points at it.',
    }),
    ApiOkResponse({ type: SpaceResponseDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'The id is not a UUID.',
    }),
    ApiNotFoundResponse({ type: ApiErrorResponseDto, description: NO_SPACE }),
    ApiAdminOnly(),
  );
}

export function ApiUpdateSpace(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Update a space’s settings (admin only)',
      description:
        'A partial edit: only the fields present are written. An edit that ' +
        'moves nothing returns the space as it is and writes no audit entry.\n\n' +
        'The key, the map and the map’s default flag cannot be changed. A ' +
        'request naming one is refused by name rather than having it ' +
        'silently ignored.\n\n' +
        'The database refuses the combinations a space may not be: a ' +
        'default space that is not `normal`, a capacity below 1, or a ' +
        'second town hall or notice board. Each comes back with the rule it ' +
        'broke. A successful edit writes an audit entry naming the admin ' +
        'and every changed field, with its old and new value, in the same ' +
        'transaction as the row.',
    }),
    ApiOkResponse({ type: SpaceResponseDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        'A malformed field, a null where one is not allowed, an immutable ' +
        'field (`key`, `mapId`, `isMapDefault`), a default space that is ' +
        'not normal, a capacity below 1 or above ' +
        `${MAX_SPACE_CAPACITY}, a negative audio radius, or a ` +
        'hysteresis factor that is not positive.',
      content: {
        'application/json': {
          examples: {
            immutable: {
              summary: 'An immutable field',
              value: {
                error: {
                  code: 'INVALID_ARGUMENT',
                  message: 'Request validation failed',
                  details: { fields: { key: 'key cannot be changed' } },
                },
              },
            },
            defaultNotNormal: {
              summary: 'The default space must stay normal',
              value: {
                error: {
                  code: 'INVALID_ARGUMENT',
                  message: 'The default space must be open to everybody',
                  details: {
                    spaceId: '55555555-5555-4555-8555-555555555555',
                    fields: {
                      access: 'The default space must be open to everybody',
                    },
                  },
                },
              },
            },
            capacity: {
              summary: 'A capacity below 1',
              value: {
                error: {
                  code: 'INVALID_ARGUMENT',
                  message: 'Capacity must be at least 1',
                  details: {
                    spaceId: '55555555-5555-4555-8555-555555555555',
                    fields: { capacity: 'Capacity must be at least 1' },
                  },
                },
              },
            },
          },
        },
      },
    }),
    ApiNotFoundResponse({ type: ApiErrorResponseDto, description: NO_SPACE }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description:
        'The campus already has a town hall or a notice board, and this ' +
        'space is being made one.',
      content: {
        'application/json': {
          examples: {
            townHall: {
              summary: 'A second town hall',
              value: {
                error: {
                  code: 'CONFLICT',
                  message: 'The campus already has a town hall',
                  details: {
                    spaceId: '55555555-5555-4555-8555-555555555555',
                    kind: 'town_hall',
                  },
                },
              },
            },
            noticeBoard: {
              summary: 'A second notice board',
              value: {
                error: {
                  code: 'CONFLICT',
                  message: 'The campus already has a notice board',
                  details: {
                    spaceId: '55555555-5555-4555-8555-555555555555',
                    kind: 'notice_board',
                  },
                },
              },
            },
          },
        },
      },
    }),
    ApiAdminOnly(),
  );
}
