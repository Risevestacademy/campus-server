import { applyDecorators } from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';

export function ApiCallWebhook(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Receive a LiveKit webhook (LiveKit only)',
      description:
        'Where the LiveKit project sends its webhooks. Signed by LiveKit ' +
        'with the key pair in LIVEKIT_WEBHOOK_API_KEY and ' +
        'LIVEKIT_WEBHOOK_API_SECRET; the signature is checked against the ' +
        'raw body. Records when a space’s call opens and closes, who joins ' +
        'and leaves it, and whether they turn their camera on. Events for ' +
        'any other room are acknowledged and ignored.',
    }),
    ApiNoContentResponse({ description: 'Received.' }),
    ApiUnauthorizedResponse({
      type: ApiErrorResponseDto,
      description: 'The signature is missing, or does not match the body.',
    }),
    ApiServiceUnavailableResponse({
      type: ApiErrorResponseDto,
      description: 'No webhook key pair is configured here.',
    }),
  );
}
