import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import {
  SignedReadDto,
  UploadDto,
  UploadLimitsDto,
} from '../dto/upload.dto.js';

const unauthorized = ApiUnauthorizedResponse({
  type: ApiErrorResponseDto,
  description: 'No usable full-access session.',
});

export function ApiCreateUpload(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Get a URL to upload a file to',
      description:
        'Signs a PUT straight to storage for one file of this kind, type and ' +
        'size. PUT the file to `uploadUrl` with `headers` within 10 minutes, ' +
        'then hand `mediaId` to the endpoint that uses it. A different type ' +
        'or size is refused by storage. An upload nothing uses within an ' +
        'hour is deleted.',
    }),
    ApiCreatedResponse({ type: UploadDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        'An unknown kind, or a size that is not a whole number above 0.',
    }),
    unauthorized,
    ApiPayloadTooLargeResponse({
      type: ApiErrorResponseDto,
      description:
        'Larger than this kind allows (`UPLOAD_TOO_LARGE`, `details.maxBytes`).',
    }),
    ApiUnsupportedMediaTypeResponse({
      type: ApiErrorResponseDto,
      description:
        'A type this kind does not take (`UPLOAD_TYPE_NOT_ALLOWED`, `details.allowed`).',
    }),
    ApiTooManyRequestsResponse({
      type: ApiErrorResponseDto,
      description:
        'Twenty of your uploads from the last hour are still unused, or more than 30 asked for in a minute.',
    }),
    ApiServiceUnavailableResponse({
      type: ApiErrorResponseDto,
      description: 'Uploads are not configured here.',
    }),
  );
}

export function ApiUploadLimits(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'What each kind of upload may be',
      description:
        'The types and largest size each kind takes, to check a file before asking for a URL.',
    }),
    ApiOkResponse({ type: UploadLimitsDto }),
    unauthorized,
  );
}

export function ApiReadMedia(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'A fresh link to an attachment',
      description:
        'For refreshing an attachment link that has expired or answered 403. ' +
        'The link lasts 15 minutes. Images open in the browser; anything ' +
        'else downloads. Only for someone who can see what the file is ' +
        'attached to: a notice they can see, feedback an admin may read, or ' +
        'a call in a space they may enter.',
    }),
    ApiOkResponse({ type: SignedReadDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'An id that is not a UUID.',
    }),
    unauthorized,
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description:
        'No such file, or not one you may read: the same answer either way.',
    }),
    ApiGoneResponse({
      type: ApiErrorResponseDto,
      description:
        'A file you could read, since let go by its owner, such as one sent in a call that has ended (`MEDIA_GONE`). Show it as no longer available.',
    }),
    ApiServiceUnavailableResponse({
      type: ApiErrorResponseDto,
      description: 'Uploads are not configured here.',
    }),
  );
}
