import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  answerPreflight,
  errorBody,
  grantOrigin,
  signIn,
} from '../http/routes.js';
import type { AccountLookup } from '../infra/accounts.js';
import type { Env } from '../infra/env.js';
import type { PresenceStore } from '../infra/presence.js';

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
  answerPreflight(app, env, ONLINE_COUNT_PATH, 'GET');
  app.get(ONLINE_COUNT_PATH, { onRequest: grantOrigin(env) }, handle);

  async function handle(request: FastifyRequest, reply: FastifyReply) {
    const caller = await signIn(env, accounts, request, reply, 'online count');
    if (!caller.ok) {
      return caller.reply;
    }
    if (!caller.account.admin) {
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
