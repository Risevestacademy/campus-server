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
import { SpaceMembershipResponseDto } from '../dto/space-membership.dto.js';

const NO_SPACE = 'No space with that id.';

export function ApiGrantSpaceMembership(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Grant access to a space (admin only)',
      description:
        'Gives one person, or everybody on one cohort track, standing ' +
        'access to the space: a row in `space_memberships`, which is what ' +
        'the `invite` and `request` settings answer entry from.\n\n' +
        'A grant is to one subject, never both and never neither. It may ' +
        'carry an end date (`validTo`, in the future: a date, read as ' +
        'midnight UTC, or a timestamp with its zone); left out, ' +
        'it has no end until an admin ends it. A grant starts the moment it ' +
        'is given.\n\n' +
        'Ending access later keeps this row: `DELETE` sets its end date and ' +
        'the row stays as the record. Granting again after that opens a new ' +
        'row beside it.\n\n' +
        'Refused with 409 when the space is retired, or when the subject ' +
        'already holds a grant on this space that covers now — end that one ' +
        'first, or wait for it to run out. Each grant writes an audit entry ' +
        'naming the admin, in the same transaction as the row.',
    }),
    ApiCreatedResponse({
      type: SpaceMembershipResponseDto,
      description: 'The grant, with `live` read at this moment.',
    }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        'Both `userId` and `cohortTrackId` were sent, or neither; an id is ' +
        'not a UUID; or `validTo` is not a date or zoned timestamp in the ' +
        'future.',
    }),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: NO_SPACE,
      content: {
        'application/json': {
          examples: {
            noSpace: {
              summary: 'No such space',
              value: {
                error: {
                  code: 'NOT_FOUND',
                  message: 'No space with id 55555555-…',
                },
              },
            },
            noSubject: {
              summary: 'No such subject',
              value: {
                error: {
                  code: 'NOT_FOUND',
                  message: 'No cohort runs a track with id 33333333-…',
                },
              },
            },
          },
        },
      },
    }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description:
        'The space is retired, or the subject already holds a live grant ' +
        'on it.',
      content: {
        'application/json': {
          examples: {
            retired: {
              summary: 'Retired space',
              value: {
                error: {
                  code: 'CONFLICT',
                  message:
                    'Space 55555555-… is retired, and no access is granted to it',
                },
              },
            },
            alreadyLive: {
              summary: 'Already granted',
              value: {
                error: {
                  code: 'CONFLICT',
                  message:
                    'That person already holds a live grant on this space',
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

export function ApiEndSpaceMembership(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'End a grant of access to a space (admin only)',
      description:
        'Sets the grant’s end date to now. The row stays, so the list keeps ' +
        'saying who had access and until when — until the track an ended ' +
        'grant names is detached from its cohort, which clears it; the ' +
        'audit log keeps the record after that. A grant on a retired space ' +
        'may still be ended — taking access away is not giving it.\n\n' +
        'Writes an audit entry naming the admin, in the same transaction ' +
        'as the change.',
    }),
    ApiNoContentResponse({ description: 'The grant has been ended.' }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'The space id or the grant id is not a UUID.',
    }),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No such grant on that space.',
    }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description:
        'The grant has already ended — its row stays as it is — or it has ' +
        'not started yet, and a window cannot close before it opens.',
      content: {
        'application/json': {
          examples: {
            alreadyEnded: {
              summary: 'Already ended',
              value: {
                error: {
                  code: 'CONFLICT',
                  message:
                    'That grant already ended at 2026-10-19T12:00:00.000Z',
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

export function ApiListSpaceMemberships(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'List the grants of access to a space (admin only)',
      description:
        'Every grant on the space, ended ones included — they are the ' +
        'record of who has had access, and when (an ended grant to a track ' +
        'goes when that track is detached from its cohort). `live` says ' +
        'which count right now, read at the moment of the request. ' +
        'Earliest grant first.',
    }),
    ApiOkResponse({
      type: [SpaceMembershipResponseDto],
      description: 'The grants, oldest first.',
    }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'The space id is not a UUID.',
    }),
    ApiNotFoundResponse({ type: ApiErrorResponseDto, description: NO_SPACE }),
    ApiAdminOnly(),
  );
}
