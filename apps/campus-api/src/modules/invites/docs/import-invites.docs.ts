import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
} from '@nestjs/swagger';

import { ApiAdminOnly } from '../../../shared/dto/admin-route.docs.js';
import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { InviteImportResponseDto } from '../dto/invite-import.dto.js';

/**
 * OpenAPI description of the CSV import. See ApiCreateInvite for why these
 * live apart from the routes.
 */
export function ApiImportInvites(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Invite a cohort from a CSV file (admin only)',
      description:
        'Uploads one file and creates one invite per row, all to the ' +
        'cohort named in `cohortId`. Each row is an ordinary invite, held ' +
        'to the same rules as POST /v1/invites and emailed the same way.\n\n' +
        '**The file.** UTF-8, comma-separated, with a header row. Up to ' +
        '500 rows and 256 KB.\n\n' +
        '| Column | Required | Value |\n' +
        '| --- | --- | --- |\n' +
        '| `email` | yes | The address to invite |\n' +
        '| `role` | yes | `student`, `professor`, `mentor` or `guest` |\n' +
        '| `track` | for students | A track code the cohort runs, e.g. `SE` |\n' +
        '| `visit_ends` | for guests | When the visit ends, e.g. `2026-11-30T17:00:00Z` |\n\n' +
        'Columns may come in any order, and other columns are ignored.\n\n' +
        '**The answer.** Always 200 once the file can be read, with one ' +
        'entry per row saying whether it was invited or why it was not. A ' +
        'row that fails does not stop the others: fix it and upload the ' +
        'file again, and the rows already invited are refused the second ' +
        'time as already invited.\n\n' +
        'Each invited row carries its `inviteLink`, shown this once, and ' +
        '`emailStatus`. Share the link by hand where the email did not go.\n\n' +
        'A file that cannot be read as a list of invites at all — empty, ' +
        'no header, a required column missing, too many rows — is a 400 ' +
        'and invites nobody.',
    }),
    ApiConsumes('multipart/form-data'),
    ApiBody({
      schema: {
        type: 'object',
        required: ['cohortId', 'file'],
        properties: {
          cohortId: {
            type: 'string',
            format: 'uuid',
            description: 'The cohort every row is invited to.',
          },
          file: {
            type: 'string',
            format: 'binary',
            description: 'The CSV file.',
          },
        },
      },
    }),
    ApiOkResponse({ type: InviteImportResponseDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        'No file, a cohortId that is not a UUID, or a file that cannot be ' +
        'read as a list of invites.',
      content: {
        'application/json': {
          examples: {
            missingColumn: {
              summary: 'A required column is missing',
              value: {
                error: {
                  code: 'INVALID_ARGUMENT',
                  message:
                    'The first row must name the columns, and "role" is missing',
                  details: { columns: ['email', 'track'] },
                },
              },
            },
          },
        },
      },
    }),
    ApiAdminOnly(),
    ApiNotFoundResponse({
      type: ApiErrorResponseDto,
      description: 'No cohort has this id.',
    }),
    ApiPayloadTooLargeResponse({
      type: ApiErrorResponseDto,
      description: 'The file is larger than 256 KB.',
    }),
  );
}
