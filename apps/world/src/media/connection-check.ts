import { mintConnectionCheckToken } from '@campus/media';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  answerPreflight,
  errorBody,
  grantOrigin,
  signIn,
} from '../http/routes.js';
import type { AccountLookup } from '../infra/accounts.js';
import { mediaCredentials, type Env } from '../infra/env.js';
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

    answerPreflight(scope, env, CONNECTION_CHECK_PATH, 'POST', [
      'content-type',
    ]);
    scope.post(
      CONNECTION_CHECK_PATH,
      { onRequest: grantOrigin(env, ['retry-after']) },
      handle,
    );
  });

  async function handle(request: FastifyRequest, reply: FastifyReply) {
    const caller = await signIn(
      env,
      accounts,
      request,
      reply,
      'connection check',
      ({ userId }) => {
        const retryAfter = budget.take(userId, now());
        if (retryAfter === 0) return undefined;
        return reply
          .status(429)
          .header('retry-after', String(retryAfter))
          .send(
            errorBody(
              'RATE_LIMITED',
              'Too many connection checks. Wait a minute and try again.',
            ),
          );
      },
    );
    if (!caller.ok) {
      return caller.reply;
    }
    const { userId } = caller.claims;

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
