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
import { MentorshipGroupResponseDto } from '../dto/mentorship-group-response.dto.js';

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

const groupNotFound = {
  summary: 'No such group in this cohort',
  value: {
    error: {
      code: 'NOT_FOUND',
      message:
        'Mentorship group aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa not found in cohort 11111111-1111-4111-8111-111111111111',
      details: {
        cohortId: '11111111-1111-4111-8111-111111111111',
        groupId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    },
  },
};

export function ApiCreateMentorshipGroup(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Create a mentorship group (admin only)',
      description:
        'Creates an empty pod in a cohort: one mentor and a name, optionally ' +
        'a description and a room. Students are added separately.\n\n' +
        'The mentor is a cohort membership, not a user: mentorMemberId is ' +
        'the `id` the roster returns. It must be a live mentor of this ' +
        'cohort. Names are unique per cohort, ignoring case. A space belongs ' +
        'to at most one group, and a mentor leads at most one group per ' +
        'cohort.',
    }),
    ApiCreatedResponse({ type: MentorshipGroupResponseDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        'A malformed body, a blank or too-long name, or a mentor/student ' +
        'from another cohort or with the wrong role.',
    }),
    ApiAdminOnly(),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description:
        'The cohort, the mentor membership or the space does not exist.',
      content: {
        'application/json': {
          examples: {
            cohortNotFound,
            mentorNotFound: {
              summary: 'No such mentor membership',
              value: {
                error: {
                  code: 'NOT_FOUND',
                  message:
                    'No membership 77777777-7777-4777-8777-777777777777 in cohort 11111111-1111-4111-8111-111111111111',
                  details: {
                    cohortId: '11111111-1111-4111-8111-111111111111',
                    mentorMemberId: '77777777-7777-4777-8777-777777777777',
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
      description:
        'The name is already used in this cohort, the mentor already leads ' +
        'a group there, or the space is already assigned.',
      content: {
        'application/json': {
          examples: {
            duplicateName: {
              summary: 'Name taken in the cohort',
              value: {
                error: {
                  code: 'CONFLICT',
                  message:
                    'A mentorship group with that name already exists in this cohort',
                  details: {
                    cohortId: '11111111-1111-4111-8111-111111111111',
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

export function ApiListMentorshipGroups(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: "List a cohort's mentorship groups (admin only)",
      description:
        'Every group in the cohort, by name, a page at a time, each with its ' +
        'mentor and all of its current students. A student who has left or ' +
        'whose membership ended is not listed.',
    }),
    ApiPaginatedResponse(MentorshipGroupResponseDto),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'cohortId is not a UUID, or a page parameter is invalid.',
    }),
    ApiAdminOnly(),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No cohort has this id.',
      content: { 'application/json': { examples: { cohortNotFound } } },
    }),
  );
}

export function ApiGetMentorshipGroup(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Get a mentorship group (admin only)',
      description:
        'One group, with its mentor and current students. The group must ' +
        'belong to the cohort in the URL.',
    }),
    ApiOkResponse({ type: MentorshipGroupResponseDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'cohortId or groupId is not a UUID.',
    }),
    ApiAdminOnly(),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'The cohort does not exist, or it has no such group.',
      content: {
        'application/json': {
          examples: { cohortNotFound, groupNotFound },
        },
      },
    }),
  );
}

export function ApiUpdateMentorshipGroup(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Rename or edit a mentorship group (admin only)',
      description:
        'A partial edit: only the fields present are written. name is ' +
        'trimmed and must be unique in the cohort, ignoring case. ' +
        'description and spaceId accept null to clear them. Changing the ' +
        'mentor has its own route.',
    }),
    ApiOkResponse({ type: MentorshipGroupResponseDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        'A malformed field, a blank name, or a space or group that does not ' +
        'belong here.',
    }),
    ApiAdminOnly(),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'The cohort, group or space does not exist.',
      content: {
        'application/json': {
          examples: { cohortNotFound, groupNotFound },
        },
      },
    }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description:
        'Another group in the cohort has that name, or the space is already ' +
        'assigned to one.',
    }),
  );
}

export function ApiChangeMentorshipGroupMentor(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: "Change a mentorship group's mentor (admin only)",
      description:
        'Replaces the group’s mentor. The new mentor is a cohort ' +
        'membership: mentorMemberId is the `id` the roster returns, and it ' +
        'must be a live mentor of this cohort. A mentor leads at most one ' +
        'group per cohort.',
    }),
    ApiOkResponse({ type: MentorshipGroupResponseDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        'A malformed body, or a membership that is not a mentor of this ' +
        'cohort.',
    }),
    ApiAdminOnly(),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'The cohort, group or mentor membership does not exist.',
      content: {
        'application/json': {
          examples: { cohortNotFound, groupNotFound },
        },
      },
    }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description:
        'The mentor membership has ended, or the mentor already leads ' +
        'another group in this cohort.',
    }),
  );
}

export function ApiAddMentorshipGroupStudent(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Add a student to a mentorship group (admin only)',
      description:
        'Adds one live student of the cohort to the group. ' +
        'cohortMemberId is the membership `id` the roster returns, not a ' +
        'user id. A student belongs to at most one group per cohort, and ' +
        'adding them twice is a 409. The response is the updated group.',
    }),
    ApiCreatedResponse({ type: MentorshipGroupResponseDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        'A malformed body, or a membership that is not a student of this ' +
        'cohort.',
    }),
    ApiAdminOnly(),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'The cohort, group or student membership does not exist.',
      content: {
        'application/json': {
          examples: { cohortNotFound, groupNotFound },
        },
      },
    }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description:
        'The student is already in this group, is in another group in the ' +
        'cohort, or their membership is no longer live.',
      content: {
        'application/json': {
          examples: {
            alreadyInGroup: {
              summary: 'Already in a group in this cohort',
              value: {
                error: {
                  code: 'CONFLICT',
                  message:
                    'That student is already in a mentorship group in this cohort',
                  details: {
                    cohortId: '11111111-1111-4111-8111-111111111111',
                    cohortMemberId: '99999999-9999-4999-8999-999999999999',
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

export function ApiRemoveMentorshipGroupStudent(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Remove a student from a mentorship group (admin only)',
      description:
        'Takes one membership out of the group. It is a 404 if that ' +
        'membership is not in the group, rather than a silent success. The ' +
        'student stays in the cohort.',
    }),
    ApiNoContentResponse({ description: 'The student was removed.' }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'cohortId, groupId or cohortMemberId is not a UUID.',
    }),
    ApiAdminOnly(),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description:
        'The cohort or group does not exist, or the student is not in the ' +
        'group.',
      content: {
        'application/json': {
          examples: { cohortNotFound, groupNotFound },
        },
      },
    }),
  );
}

export function ApiDeleteMentorshipGroup(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Delete a mentorship group (admin only)',
      description:
        'Removes the group and its student links. The students stay in the ' +
        'cohort. The group must belong to the cohort in the URL. A group ' +
        'that an invite still names is refused with a 409: revoke or remove ' +
        'the invite first.',
    }),
    ApiNoContentResponse({ description: 'The group was deleted.' }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'cohortId or groupId is not a UUID.',
    }),
    ApiAdminOnly(),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'The cohort does not exist, or it has no such group.',
      content: {
        'application/json': {
          examples: { cohortNotFound, groupNotFound },
        },
      },
    }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description: 'An invite still names the group.',
      content: {
        'application/json': {
          examples: {
            referencedByInvite: {
              summary: 'Invite references the group',
              value: {
                error: {
                  code: 'CONFLICT',
                  message:
                    'Mentorship group cannot be deleted while an invite names it',
                  details: {
                    cohortId: '11111111-1111-4111-8111-111111111111',
                    groupId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
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
