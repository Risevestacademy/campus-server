import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { DeskDto } from '../dto/desk.dto.js';

const noSession = ApiUnauthorizedResponse({
  type: ApiErrorResponseDto,
  description: 'No usable full-access session.',
});

const badParams = ApiBadRequestResponse({
  type: ApiErrorResponseDto,
  description: 'The cohort id is not a UUID, or the key is blank or too long.',
});

export function ApiListDesks(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: "List a cohort's desks",
      description:
        'Every desk on the published maps, by map and key, with who holds ' +
        'it in this cohort. Each cohort has its own holder for a desk.\n\n' +
        "For the cohort's live members, guests included, and for admins.",
    }),
    ApiOkResponse({ type: [DeskDto] }),
    badParams,
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

export function ApiClaimDesk(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Claim a desk',
      description:
        'The caller takes the desk in this cohort. Claiming the desk they ' +
        'hold changes nothing; claiming another moves them to it, letting ' +
        'go of the first.\n\n' +
        'For admins, and for live members of the cohort but guests. A claim ' +
        'lasts until the holder lets go, an admin frees it, their membership ' +
        'ends, or the desk leaves the map.',
    }),
    ApiOkResponse({ type: DeskDto }),
    badParams,
    noSession,
    ApiForbiddenResponse({
      type: ApiErrorResponseDto,
      description:
        'The caller is a guest, or holds no live place in this cohort and is ' +
        'not an admin.',
    }),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description:
        'No desk with that key on the map, or (admins) no such cohort.',
    }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description:
        'Somebody else holds the desk, or it changed hands while claiming.',
    }),
  );
}

export function ApiReleaseDesk(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Let go of a desk, or free one (admins)',
      description:
        'Ends the claim on the desk in this cohort. The holder may let go of ' +
        "their own; only an admin may free somebody else's, which is " +
        'audited as `desk_freed`. A desk nobody holds is answered as it is, ' +
        'so a retried release succeeds.',
    }),
    ApiOkResponse({ type: DeskDto }),
    badParams,
    noSession,
    ApiForbiddenResponse({
      type: ApiErrorResponseDto,
      description:
        "The desk is somebody else's and the caller is not an admin, or the " +
        'caller holds no live place in this cohort.',
    }),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description:
        'No desk with that key on the map, or (admins) no such cohort.',
    }),
  );
}
