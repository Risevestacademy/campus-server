/** Fields that never reach a log line, wherever the services log them. */
const SECRET_FIELDS = [
  'password',
  'token',
  'secret',
  'email',
  'idToken',
  'refreshToken',
  'accessToken',
];

/**
 * pino `redact` paths, shared by campus-api and world. pino has no deep
 * wildcard, so each field is listed at the top of a line, one level down,
 * and under an error's `details`, where domain exceptions carry theirs.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  ...SECRET_FIELDS.flatMap((field) => [
    field,
    `*.${field}`,
    `err.details.${field}`,
  ]),
];
