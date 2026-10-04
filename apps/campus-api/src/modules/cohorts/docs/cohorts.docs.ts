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
import {
  CohortDetailResponseDto,
  CohortResponseDto,
  CohortTrackResponseDto,
} from '../dto/cohort-response.dto.js';

const cohortNotFound = {
  summary: 'No such cohort',
  value: {
    error: {
      code: 'NOT_FOUND',
      message: 'Cohort 11111111-1111-4111-8111-111111111111 not found',
      details: { cohortId: '11111111-1111-4111-8111-111111111111' },
    },
  },
};

export function ApiCreateCohort(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Create a cohort (admin only)',
      description:
        'Creates an intake with no tracks; attach them with ' +
        'POST /v1/cohorts/{id}/tracks before inviting students, who each ' +
        'need a cohortTrackId. code is trimmed and uppercased, and must be ' +
        'unique. status defaults to upcoming.',
    }),
    ApiCreatedResponse({ type: CohortResponseDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        'A missing or malformed field, or an endDate before startDate.',
      content: {
        'application/json': {
          examples: {
            endBeforeStart: {
              summary: 'endDate before startDate',
              value: {
                error: {
                  code: 'INVALID_ARGUMENT',
                  message: 'Request validation failed',
                  details: {
                    fields: {
                      endDate: 'endDate must be on or after startDate',
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
    ApiAdminOnly(),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description: 'Another cohort already has this code.',
      content: {
        'application/json': {
          examples: {
            duplicateCode: {
              summary: 'Code taken',
              value: {
                error: {
                  code: 'CONFLICT',
                  message: 'A cohort with code C1 already exists',
                  details: { code: 'C1' },
                },
              },
            },
          },
        },
      },
    }),
  );
}

export function ApiListCohorts(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'List cohorts (admin only)',
      description:
        'Every cohort, newest first. Tracks are on the detail route.',
    }),
    ApiPaginatedResponse(CohortResponseDto),
    ApiAdminOnly(),
  );
}

export function ApiGetCohort(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Get a cohort with its tracks (admin only)',
      description:
        'Each entry in tracks has the cohortTrackId (its id) a student ' +
        'invite to this cohort names.',
    }),
    ApiOkResponse({ type: CohortDetailResponseDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'id is not a UUID.',
    }),
    ApiAdminOnly(),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No cohort has this id.',
      content: { 'application/json': { examples: { cohortNotFound } } },
    }),
  );
}

export function ApiAttachTrack(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Attach a track to a cohort (admin only)',
      description:
        'Makes a catalogue track one this cohort runs. The response id is ' +
        'the cohortTrackId for student invites.',
    }),
    ApiCreatedResponse({ type: CohortTrackResponseDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'id or trackId is not a UUID.',
    }),
    ApiAdminOnly(),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'The cohort or the track does not exist.',
      content: {
        'application/json': {
          examples: {
            cohortNotFound,
            trackNotFound: {
              summary: 'No such track',
              value: {
                error: {
                  code: 'NOT_FOUND',
                  message:
                    'Track 33333333-3333-4333-8333-333333333333 not found',
                  details: { trackId: '33333333-3333-4333-8333-333333333333' },
                },
              },
            },
          },
        },
      },
    }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description: 'The cohort already runs this track.',
      content: {
        'application/json': {
          examples: {
            alreadyAttached: {
              summary: 'Already attached',
              value: {
                error: {
                  code: 'CONFLICT',
                  message: 'Track SE is already attached to this cohort',
                  details: {
                    cohortId: '11111111-1111-4111-8111-111111111111',
                    trackId: '33333333-3333-4333-8333-333333333333',
                  },
                },
              },
            },
          },
        },
      },
    }),
  );
}

export function ApiUpdateCohort(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Update a cohort (admin only)',
      description:
        'A partial edit: only the fields present are written. code is ' +
        'trimmed and uppercased, and must be unique. An endDate before the ' +
        'merged startDate is refused. null clears startDate or endDate; ' +
        'name, code and status cannot be cleared.',
    }),
    ApiOkResponse({ type: CohortResponseDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        'A malformed field, a null name, code or status, or an endDate ' +
        'before startDate. id is not a UUID.',
    }),
    ApiAdminOnly(),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No cohort has this id.',
      content: { 'application/json': { examples: { cohortNotFound } } },
    }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description: 'Another cohort already has this code.',
      content: {
        'application/json': {
          examples: {
            duplicateCode: {
              summary: 'Code taken',
              value: {
                error: {
                  code: 'CONFLICT',
                  message: 'A cohort with code C1 already exists',
                  details: { code: 'C1' },
                },
              },
            },
          },
        },
      },
    }),
  );
}

export function ApiDetachTrack(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Detach a track from a cohort (admin only)',
      description:
        'Stops the cohort running a track: the reverse of ' +
        'POST /v1/cohorts/{id}/tracks, named by the same `trackId`. The ' +
        'track itself stays in the catalogue.\n\n' +
        'Refused with a 409 while anything in the cohort is still on the ' +
        'track — a student placed on it, or an invite that names it, ' +
        'whether pending or already settled. Nothing is moved or removed ' +
        'for you.\n\n' +
        'A cohort has to have its tracks detached before it can be deleted.',
    }),
    ApiNoContentResponse({ description: 'The track was detached.' }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'id or trackId is not a UUID.',
    }),
    ApiAdminOnly(),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description:
        'No cohort has this id, or the cohort does not run this track.',
      content: {
        'application/json': {
          examples: {
            cohortNotFound,
            notAttached: {
              summary: 'The cohort does not run this track',
              value: {
                error: {
                  code: 'NOT_FOUND',
                  message:
                    'Track 33333333-3333-4333-8333-333333333333 is not attached to this cohort',
                  details: {
                    cohortId: '11111111-1111-4111-8111-111111111111',
                    trackId: '33333333-3333-4333-8333-333333333333',
                  },
                },
              },
            },
          },
        },
      },
    }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description: 'Students or invites in the cohort are still on the track.',
      content: {
        'application/json': {
          examples: {
            inUse: {
              summary: 'Track in use',
              value: {
                error: {
                  code: 'CONFLICT',
                  message:
                    'Track cannot be detached while students or invites in this cohort are still on it',
                  details: {
                    cohortId: '11111111-1111-4111-8111-111111111111',
                    trackId: '33333333-3333-4333-8333-333333333333',
                  },
                },
              },
            },
          },
        },
      },
    }),
  );
}

export function ApiDeleteCohort(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Delete a cohort (admin only)',
      description:
        'Removes a cohort with nothing attached to it. A cohort that still ' +
        'has tracks, members or invites is refused with a 409. Tracks come ' +
        'off with DELETE /v1/cohorts/{id}/tracks/{trackId}.',
    }),
    ApiNoContentResponse({ description: 'The cohort was deleted.' }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'id is not a UUID.',
    }),
    ApiAdminOnly(),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No cohort has this id.',
      content: { 'application/json': { examples: { cohortNotFound } } },
    }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description: 'The cohort still has tracks, members or invites.',
      content: {
        'application/json': {
          examples: {
            hasDependents: {
              summary: 'Cohort in use',
              value: {
                error: {
                  code: 'CONFLICT',
                  message:
                    'Cohort cannot be deleted while it still has tracks, members or invites',
                  details: { cohortId: '11111111-1111-4111-8111-111111111111' },
                },
              },
            },
          },
        },
      },
    }),
  );
}
