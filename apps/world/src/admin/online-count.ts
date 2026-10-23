import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AccountLookup } from '../infra/accounts.js';
import type { Env } from '../infra/env.js';
import { allowOrigin, errorBody, refuse } from '../infra/http.js';
import { CORRELATION_ID_HEADER } from '../infra/logger.js';
import type { PresenceStore } from '../infra/presence.js';
import {
  checkAccount,
  readCaller,
  type CallerHeaders,
} from '../socket/authenticate.js';

export const ONLINE_COUNT_PATH = '/admin/online';

const query = z.object({ cohortId: z.uuid().optional() });

/**
 * How many people are online now, for an admin's dashboard: across the
 * campus, or in one cohort. Somebody in two cohorts' campuses counts once in
 * the total. Read from presence, so it covers every world instance.
 */
export function registerOnlineCount(
  app: FastifyInstance,
  env: Env,
  accounts: AccountLookup,
  presence: PresenceStore,
): void {
  app.options(ONLINE_COUNT_PATH, async (request, reply) => {
    if (allowOrigin(env, request, reply)) {
      void reply
        .header('access-control-allow-methods', 'GET')
        .header(
          'access-control-allow-headers',
          `authorization, ${CORRELATION_ID_HEADER}`,
        )
        .header('access-control-max-age', '600');
    }
    return reply.status(204).send();
  });

  app.get(ONLINE_COUNT_PATH, { onRequest: grantOrigin }, handle);

  async function grantOrigin(request: FastifyRequest, reply: FastifyReply) {
    if (allowOrigin(env, request, reply)) {
      void reply.header('access-control-expose-headers', CORRELATION_ID_HEADER);
    }
  }

  async function handle(request: FastifyRequest, reply: FastifyReply) {
    const caller = await readCaller(env, request.headers as CallerHeaders);
    if (!caller.ok) {
      return refuse(request, reply, caller.refusal, 'online count');
    }
    const checked = await checkAccount(env, accounts, caller.claims);
    if (!checked.ok) {
      return refuse(request, reply, checked.refusal, 'online count');
    }
    if (!checked.account.admin) {
      return reply
        .status(403)
        .send(errorBody('FORBIDDEN', 'Only admins may see who is online.'));
    }

    const parsed = query.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(errorBody('INVALID_ARGUMENT', 'cohortId must be one UUID.'));
    }

    let online: Set<string>;
    try {
      online = await presence.onlineUserIds(parsed.data.cohortId);
    } catch (err) {
      request.log.error({ err }, 'could not count who is online');
      return reply
        .status(503)
        .send(
          errorBody(
            'PRESENCE_UNAVAILABLE',
            'Who is online cannot be read right now. Try again shortly.',
          ),
        );
    }
    return reply.header('cache-control', 'no-store').send({
      online: online.size,
    });
  }
}
