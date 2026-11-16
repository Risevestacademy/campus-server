import type { Env } from '../../infra/config/config.module.js';
import { parseCorsOrigins } from '../../infra/config/env.js';
import { SessionUnauthorizedError } from './auth.exceptions.js';

export function assertAllowedOrigin(
  config: Env,
  origin: string | undefined,
): void {
  if (origin === undefined) {
    return;
  }
  const allowed = parseCorsOrigins(config.CORS_ORIGINS);
  if (!allowed.includes(origin)) {
    throw new SessionUnauthorizedError(
      'Origin is not allowed to use this session',
    );
  }
}
