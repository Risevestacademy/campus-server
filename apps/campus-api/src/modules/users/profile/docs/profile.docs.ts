import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../../../../shared/dto/api-error-response.dto.js';
import {
  CohortProfileDto,
  OwnProfileDto,
  ProfileCardDto,
} from '../dto/profile.dto.js';

const noSession = ApiUnauthorizedResponse({
  type: ApiErrorResponseDto,
  description: 'No usable full-access session.',
});

export function ApiGetOwnProfile(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Read your own profile',
      description:
        'Everything on the signed-in account’s profile, including the ' +
        'phone number, which nobody else but an admin sees, and every ' +
        'cohort they hold a live place in.',
    }),
    ApiOkResponse({ type: OwnProfileDto }),
    noSession,
  );
}

export function ApiUpdateOwnProfile(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Update your own profile',
      description:
        'A partial update: names, display name, phone, bio and sprite. Leave a ' +
        'field out to keep it; send `null` or an empty string to clear it. ' +
        'Values are trimmed.\n\n' +
        'The address cannot be changed here: it is the Google account the ' +
        'person signs in with. Roles and memberships are not the person’s ' +
        'to edit, and neither, yet, is the photo.',
    }),
    ApiOkResponse({ type: OwnProfileDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        'A field is too long, the phone is not a phone number, or the sprite ' +
        'is not one of the allowed keys.',
    }),
    noSession,
  );
}

export function ApiGetProfileCard(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'View a member’s profile card',
      description:
        'What one member sees of another: names, photo, bio, address and ' +
        'the cohorts the two share. The phone number is never on a card.\n\n' +
        'A member can open the card of anybody they share a live cohort ' +
        'with, and sees only the shared cohorts. An admin can open any ' +
        'card and sees every live cohort, as does a person opening their ' +
        'own.\n\n' +
        'Anything else answers 404 — no such account, a suspended one, or ' +
        'one the caller shares no cohort with — so a card cannot be used to ' +
        'find out who has an account.',
    }),
    ApiOkResponse({ type: ProfileCardDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'The id is not a UUID.',
    }),
    noSession,
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No profile the caller may see under this id.',
    }),
  );
}

export function ApiListCohortProfiles(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: "List a cohort's people",
      description:
        'Everybody with a live place in the cohort, with their display name ' +
        'and sprite, for the sidebar: the whole cohort in one response, ' +
        'sorted by display name with unnamed people last. Who of them is ' +
        'online, and where, comes from the world socket.\n\n' +
        "For the cohort's live members and for admins. Suspended accounts " +
        'are listed for admins only.',
    }),
    ApiOkResponse({ type: [CohortProfileDto] }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'The cohort id is not a UUID.',
    }),
    noSession,
    ApiForbiddenResponse({
      type: ApiErrorResponseDto,
      description:
        'The caller holds no live place in this cohort and is not an admin.',
    }),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No cohort with that id (admins only; others get 403).',
    }),
  );
}
