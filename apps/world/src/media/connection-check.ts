import { mintConnectionCheckToken } from '@campus/media';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AccountLookup } from '../infra/accounts.js';
import { allowedOrigins, mediaCredentials, type Env } from '../infra/env.js';
import { CORRELATION_ID_HEADER } from '../infra/logger.js';
import {
  checkAccount,
  readCaller,
  type CallerHeaders,
  type Refusal,
} from '../socket/authenticate.js';
import { CheckBudget } from './check-budget.js';

export const CONNECTION_CHECK_PATH = '/media/connection-check';

/**
 * A token for the pre-join device and network check: LiveKit's connection
 * test, run before somebody is put in a room with anyone. The room is made up
 * per call, so the token joins nobody (see `mintConnectionCheckToken`).
 */
export function registerConnectionCheck(
  app: FastifyInstance,
  env: Env,
  accounts: AccountLookup,
  now: () => number = Date.now,
): void {
  const credentials = mediaCredentials(env);
  const budget = new CheckBudget(env.WORLD_CONNECTION_CHECKS_PER_MINUTE, now());

  function allowOrigin(request: FastifyRequest, reply: FastifyReply): boolean {
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

  // A bearer token makes the request non-simple, so the browser asks first.
  app.options(CONNECTION_CHECK_PATH, async (request, reply) => {
    if (allowOrigin(request, reply)) {
      void reply
        .header('access-control-allow-methods', 'POST')
        .header(
          'access-control-allow-headers',
          `authorization, ${CORRELATION_ID_HEADER}`,
        )
        .header('access-control-max-age', '600');
    }
    return reply.status(204).send();
  });

  app.post(CONNECTION_CHECK_PATH, async (request, reply) => {
    if (allowOrigin(request, reply)) {
      void reply.header(
        'access-control-expose-headers',
        `${CORRELATION_ID_HEADER}, retry-after`,
      );
    }

    const caller = await readCaller(env, request.headers as CallerHeaders);
    if (!caller.ok) {
      return refuse(request, reply, caller.refusal);
    }
    const { userId } = caller.claims;

    // Before the account lookups, so a flood costs no queries.
    const retryAfter = budget.take(userId, now());
    if (retryAfter > 0) {
      return reply
        .status(429)
        .header('retry-after', String(retryAfter))
        .send(
          errorBody(
            'RATE_LIMITED',
            'Too many connection checks. Wait a minute and try again.',
          ),
        );
    }

    const checked = await checkAccount(env, accounts, caller.claims);
    if (!checked.ok) {
      return refuse(request, reply, checked.refusal);
    }

    // After sign-in, so only members learn how this deployment is set up.
    if (!credentials) {
      return reply
        .status(503)
        .send(
          errorBody(
            'MEDIA_NOT_CONFIGURED',
            'Audio and video are not set up on this deployment.',
          ),
        );
    }

    const minted = await mintConnectionCheckToken(credentials, userId);
    request.log.info({ userId, room: minted.room }, 'connection check token');
    return reply.header('cache-control', 'no-store').send({
      url: minted.url,
      room: minted.room,
      token: minted.token,
      expiresAt: minted.expiresAt.toISOString(),
    });
  });
}

/**
 * The status campus-api answers the same session with: 401 for anything about
 * the token or account, 403 for a page world does not serve.
 */
function refuse(
  request: FastifyRequest,
  reply: FastifyReply,
  refusal: Refusal,
): FastifyReply {
  request.log.info({ refusal }, 'connection check refused');
  if (refusal === 'origin_not_allowed') {
    return reply
      .status(403)
      .send(errorBody('FORBIDDEN', 'This origin may not call world.', refusal));
  }
  return reply
    .status(401)
    .send(errorBody('UNAUTHORIZED', 'Authentication required', refusal));
}

function errorBody(code: string, message: string, reason?: Refusal) {
  return {
    error: { code, message, ...(reason ? { details: { reason } } : {}) },
  };
}
