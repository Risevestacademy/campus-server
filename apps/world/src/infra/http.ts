import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Refusal } from '../socket/authenticate.js';
import { allowedOrigins, type Env } from './env.js';

/** Grants CORS, with credentials, to an origin on world's list. */
export function allowOrigin(
  env: Env,
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  void reply.header('vary', 'Origin');
  const origin = request.headers.origin;
  if (origin === undefined || !allowedOrigins(env).includes(origin)) {
    return false;
  }
  void reply
    .header('access-control-allow-origin', origin)
    .header('access-control-allow-credentials', 'true');
  return true;
}

/**
 * The status campus-api answers the same session with: 401 for anything about
 * the token or account, 403 for a page world does not serve.
 */
export function refuse(
  request: FastifyRequest,
  reply: FastifyReply,
  refusal: Refusal,
  route: string,
): FastifyReply {
  request.log.info({ refusal }, `${route} refused`);
  if (refusal === 'origin_not_allowed') {
    return reply
      .status(403)
      .send(errorBody('FORBIDDEN', 'This origin may not call world.', refusal));
  }
  return reply
    .status(401)
    .send(errorBody('UNAUTHORIZED', 'Authentication required', refusal));
}

export function errorBody(code: string, message: string, reason?: Refusal) {
  return {
    error: { code, message, ...(reason ? { details: { reason } } : {}) },
  };
}
