import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
} from '@nestjs/swagger';

import { ApiAdminOnly } from '../../../shared/dto/admin-route.docs.js';
import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { MapSyncResultDto } from '../dto/map-sync.dto.js';

export function ApiSyncMaps(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Sync the published maps (admin only)',
      description:
        'Brings what the database holds of the campus maps into line with ' +
        'what is published. Publishing a map and it taking effect here are ' +
        'two steps on purpose: this is the second, and an admin takes it.\n\n' +
        'What it changes:\n\n' +
        '- A map or space that is new gets a row. A space starts with the ' +
        'kind the map suggests, when it suggests one that is known, and ' +
        'that kind’s starting settings. With no kind it is not set up, and ' +
        'only admins may enter: those are listed under `needsKind`.\n' +
        '- A map or space no longer published is **retired**, never ' +
        'deleted.\n' +
        '- One that is published again comes back as the same row, with ' +
        'what it had.\n' +
        '- Every map is given its default space, for the tiles inside no ' +
        'drawn one.\n\n' +
        'What it never changes: a name, a kind or a setting an admin may ' +
        'have set. A sync only adds, retires and restores.\n\n' +
        'All of it happens or none of it. The published maps are read whole ' +
        'first, and if they cannot be adopted the database is not ' +
        'touched.\n\n' +
        '`?dryRun=true` answers what would change and keeps none of it. ' +
        'Running it again when nothing has been published since changes ' +
        'nothing: `changed` is false.',
    }),
    ApiOkResponse({ type: MapSyncResultDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: '`dryRun` is not `true` or `false`.',
    }),
    ApiAdminOnly(),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description:
        'The published maps were read and cannot be adopted: nothing is ' +
        'published, a map is broken, the maps do not fit together, a key ' +
        'is too long or kept for something else, or a retired town hall or ' +
        'notice board is published again while another space is one. ' +
        '`details.problems` lists everything wrong, map by map, for whoever ' +
        'publishes maps to put right. Also answered, with no details, when ' +
        'another sync is running. Nothing was changed.',
      content: {
        'application/json': {
          examples: {
            rejected: {
              summary: 'A map is broken',
              value: {
                error: {
                  code: 'CONFLICT',
                  message: 'The published maps cannot be adopted as they are.',
                  details: {
                    problems: [
                      "spaces: object 12 has no name; name it with the space's key",
                    ],
                  },
                },
              },
            },
          },
        },
      },
    }),
    ApiServiceUnavailableResponse({
      type: ApiErrorResponseDto,
      description:
        'The published maps could not be read at all. `details.reason` is ' +
        '`not_configured` when this deployment is not told where they are, ' +
        'or `unreachable` when Sanity did not answer; that one is worth ' +
        'trying again. Nothing was changed.',
      content: {
        'application/json': {
          examples: {
            unreachable: {
              summary: 'Sanity did not answer',
              value: {
                error: {
                  code: 'SERVICE_UNAVAILABLE',
                  message:
                    'The published maps could not be reached. Try again shortly.',
                  details: { reason: 'unreachable' },
                },
              },
            },
          },
        },
      },
    }),
  );
}
