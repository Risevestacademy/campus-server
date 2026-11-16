import type { SessionClaims } from '@campus/session';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Account, AccountLookup } from '../infra/accounts.js';
import { allowedOrigins, type Env } from '../infra/env.js';
import { CORRELATION_ID_HEADER } from '../infra/logger.js';
import {
  checkAccount,
  readCaller,
  type CallerHeaders,
  type Refusal,
} from '../socket/authenticate.js';

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
 * Answers the browser's preflight for a route: a bearer token makes a
 * request non-simple, so the browser asks first. Only for allowed origins.
 */
export function answerPreflight(
  scope: FastifyInstance,
  env: Env,
  path: string,
  method: 'GET' | 'POST',
  headers: readonly string[] = [],
): void {
  scope.options(path, async (request, reply) => {
    if (allowOrigin(env, request, reply)) {
      void reply
        .header('access-control-allow-methods', method)
        .header(
          'access-control-allow-headers',
          ['authorization', ...headers, CORRELATION_ID_HEADER].join(', '),
        )
        .header('access-control-max-age', '600');
    }
    return reply.status(204).send();
  });
}

/**
 * An `onRequest` hook granting CORS before the body is parsed, so a 400 from
 * the parser is readable too, with these response headers exposed.
 */
export function grantOrigin(env: Env, expose: readonly string[] = []) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (allowOrigin(env, request, reply)) {
      void reply.header(
        'access-control-expose-headers',
        [CORRELATION_ID_HEADER, ...expose].join(', '),
      );
    }
  };
}

export type SignedIn =
  | { ok: true; claims: SessionClaims; account: Account }
  | { ok: false; reply: FastifyReply };

/**
 * Who is calling, signed in as for the socket, or the refusal already sent.
 * `beforeLookup` runs between reading the token and reading the account, so
 * a limit can turn a flood away before it costs any queries.
 */
export async function signIn(
  env: Env,
  accounts: AccountLookup,
  request: FastifyRequest,
  reply: FastifyReply,
  route: string,
  beforeLookup?: (claims: SessionClaims) => FastifyReply | undefined,
): Promise<SignedIn> {
  const caller = await readCaller(env, request.headers as CallerHeaders);
  if (!caller.ok) {
    return { ok: false, reply: refuse(request, reply, caller.refusal, route) };
  }
  const stopped = beforeLookup?.(caller.claims);
  if (stopped) {
    return { ok: false, reply: stopped };
  }
  const checked = await checkAccount(env, accounts, caller.claims);
  if (!checked.ok) {
    return { ok: false, reply: refuse(request, reply, checked.refusal, route) };
  }
  return { ok: true, claims: caller.claims, account: checked.account };
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
