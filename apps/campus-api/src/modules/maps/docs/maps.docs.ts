import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
} from '@nestjs/swagger';

import { ApiAdminOnly } from '../../../shared/dto/admin-route.docs.js';
import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { MapPublishedResponseDto } from '../dto/map-publish.dto.js';
import { MapSyncResultDto } from '../dto/map-sync.dto.js';

const NO_MAP = 'No map with that id.';

export function ApiPublishMap(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Publish a synced map to world (admin only)',
      description:
        'Makes the map live for world, without restarting it. A sync only ' +
        'brings the database level with what is published; this is the ' +
        'separate decision to serve it.\n\n' +
        'The row is locked, checked, given this moment as `publishedAt`, ' +
        'and an audit entry is written in the same transaction. Publishing ' +
        'again moves the timestamp and writes another entry.\n\n' +
        'After the commit, world is told the map’s key on the same channel ' +
        'a space edit uses. That is fire-and-forget: this route does not wait ' +
        'for world, and a failed notification is logged rather than failing ' +
        'the publish.\n\n' +
        'Only the map people enter on can be published: world serves one map, ' +
        'and a different one would leave clients without a spawn. A retired ' +
        'map is refused for the same reason a retired space is.',
    }),
    ApiOkResponse({ type: MapPublishedResponseDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'The id is not a UUID.',
    }),
    ApiNotFoundResponse({ type: ApiErrorResponseDto, description: NO_MAP }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description:
        'The map is retired, or it is not the map people enter on. Nothing ' +
        'was changed and no audit entry was written.',
      content: {
        'application/json': {
          examples: {
            retired: {
              summary: 'A retired map',
              value: {
                error: {
                  code: 'CONFLICT',
                  message: 'Map "annex" is retired and cannot be published',
                  details: {
                    mapId: '55555555-5555-4555-8555-555555555555',
                    key: 'annex',
                  },
                },
              },
            },
            notEntry: {
              summary: 'A map that is not the entry map',
              value: {
                error: {
                  code: 'CONFLICT',
                  message:
                    'Map "annex" is not the map people enter on, and world serves one map',
                  details: {
                    mapId: '55555555-5555-4555-8555-555555555555',
                    key: 'annex',
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
        'drawn one.\n' +
        '- Desks are added, retired and restored the same way, by key. A ' +
        'desk drawn on another map keeps its row and moves with it. A desk ' +
        'that leaves its map, retired or moved, ends every open claim on ' +
        'it.\n\n' +
        'What it never changes: a name, a kind or a setting an admin may ' +
        'have set. Beyond ending the claims on a desk that leaves its map, ' +
        'a sync only adds, retires and restores.\n\n' +
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
