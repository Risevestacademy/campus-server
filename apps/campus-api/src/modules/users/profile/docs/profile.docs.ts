import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../../../../shared/dto/api-error-response.dto.js';
import { OwnProfileDto, ProfileCardDto } from '../dto/profile.dto.js';

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
        'A partial update: names, display name, phone and bio. Leave a ' +
        'field out to keep it; send `null` or an empty string to clear it. ' +
        'Values are trimmed.\n\n' +
        'The address cannot be changed here: it is the Google account the ' +
        'person signs in with. Roles and memberships are not the person’s ' +
        'to edit, and neither, yet, is the photo.',
    }),
    ApiOkResponse({ type: OwnProfileDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'A field is too long, or the phone is not a phone number.',
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
