import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { AttachmentDto } from '../../media/dto/upload.dto.js';

export function ApiAttachToCall(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: "Send a file in a space's call chat",
      description:
        'Ties an uploaded file to the call going on in the space. Then send ' +
        'the chat line through world with this `attachment` ' +
        '(`mediaId`, `fileName`, `contentType`, `sizeBytes`); world passes it ' +
        'on unchecked, and whoever gets it opens the file with ' +
        '`GET /v1/media/{id}/url`.\n\n' +
        'Anyone who may enter the space can open it while the call goes on. ' +
        'Once the call ends it answers 410 (`MEDIA_GONE`), and the file is ' +
        'deleted a week later.',
    }),
    ApiCreatedResponse({ type: AttachmentDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'An id is not a UUID.',
    }),
    ApiUnauthorizedResponse({
      type: ApiErrorResponseDto,
      description: 'No usable full-access session.',
    }),
    ApiForbiddenResponse({
      type: ApiErrorResponseDto,
      description: 'The caller may not enter the space.',
    }),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description:
        'No space with that id, or no `call_chat_attachment` upload of the caller’s is waiting under `mediaId`.',
    }),
    ApiConflictResponse({
      type: ApiErrorResponseDto,
      description: 'No call is going on in the space.',
    }),
    ApiUnprocessableEntityResponse({
      type: ApiErrorResponseDto,
      description:
        'Nothing was uploaded, or the file is not what its upload was signed for (`UPLOAD_MISMATCH`). Upload it again.',
    }),
    ApiServiceUnavailableResponse({
      type: ApiErrorResponseDto,
      description: 'Uploads are not configured here.',
    }),
  );
}
