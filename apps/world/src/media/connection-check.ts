import { mintConnectionCheckToken } from '@campus/media';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AccountLookup } from '../infra/accounts.js';
import { mediaCredentials, type Env } from '../infra/env.js';
import { allowOrigin, errorBody, refuse } from '../infra/http.js';
import { CORRELATION_ID_HEADER } from '../infra/logger.js';
import {
  checkAccount,
  readCaller,
  type CallerHeaders,
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

  // Its own scope, so the JSON parser below is this route's alone.
  void app.register(async (scope) => {
    // The body is never read, but a client may still mark an empty one as JSON.
    const parseJson = scope.getDefaultJsonParser('error', 'error');
    scope.addContentTypeParser<string>(
      'application/json',
      { parseAs: 'string' },
      (request, body, done) => {
        if (body === '') {
          done(null, undefined);
          return;
        }
        parseJson(request, body, done);
      },
    );

    // A bearer token makes the request non-simple, so the browser asks first.
    scope.options(CONNECTION_CHECK_PATH, async (request, reply) => {
      if (allowOrigin(env, request, reply)) {
        void reply
          .header('access-control-allow-methods', 'POST')
          .header(
            'access-control-allow-headers',
            `authorization, content-type, ${CORRELATION_ID_HEADER}`,
          )
          .header('access-control-max-age', '600');
      }
      return reply.status(204).send();
    });

    scope.post(CONNECTION_CHECK_PATH, { onRequest: grantOrigin }, handle);
  });

  // Before the body is parsed, so a 400 from the parser is readable too.
  async function grantOrigin(request: FastifyRequest, reply: FastifyReply) {
    if (allowOrigin(env, request, reply)) {
      void reply.header(
        'access-control-expose-headers',
        `${CORRELATION_ID_HEADER}, retry-after`,
      );
    }
  }

  async function handle(request: FastifyRequest, reply: FastifyReply) {
    const caller = await readCaller(env, request.headers as CallerHeaders);
    if (!caller.ok) {
      return refuse(request, reply, caller.refusal, 'connection check');
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
      return refuse(request, reply, checked.refusal, 'connection check');
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
  }
}
