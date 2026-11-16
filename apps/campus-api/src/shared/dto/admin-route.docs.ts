import { applyDecorators } from '@nestjs/common';
import { ApiForbiddenResponse, ApiUnauthorizedResponse } from '@nestjs/swagger';

import { ApiErrorResponseDto } from './api-error-response.dto.js';

/**
 * The two refusals every SessionGuard + AdminGuard route shares, documented
 * once. A suspended account is a 401, not a 403: SessionGuard refuses it
 * before AdminGuard runs, so 403 means only "signed in, not an admin".
 */
export function ApiAdminOnly(): MethodDecorator {
  return applyDecorators(
    ApiUnauthorizedResponse({
      type: ApiErrorResponseDto,
      description:
        'No usable session: none sent, unparseable, expired, provisional, or ' +
        'its account is gone or suspended.',
      content: {
        'application/json': {
          examples: {
            noSession: {
              summary: 'No usable session',
              value: {
                error: {
                  code: 'UNAUTHORIZED',
                  message: 'Authentication required',
                },
              },
            },
          },
        },
      },
    }),
    ApiForbiddenResponse({
      type: ApiErrorResponseDto,
      description: 'Signed in, but not an admin.',
      content: {
        'application/json': {
          examples: {
            notAdmin: {
              summary: 'Ordinary member',
              value: {
                error: { code: 'FORBIDDEN', message: 'Admin role required' },
              },
            },
          },
        },
      },
    }),
  );
}
