import { createHmac, timingSafeEqual } from 'node:crypto';

/** How long somebody has at Google before an OAuth state lapses. */
export const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * `<base64url JSON>.<HMAC>`. `context` keeps one flow's states from passing
 * in another that signs with the same secret.
 */
export function signState(
  secret: string,
  payload: object,
  context = '',
): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  return `${body}.${sign(secret, body, context)}`;
}

/** The payload, or null for anything this secret and context did not sign. */
export function readState(
  secret: string,
  state: string | undefined,
  context = '',
): unknown {
  const [body, signature, ...rest] = (state ?? '').split('.');
  if (
    !body ||
    !signature ||
    rest.length > 0 ||
    !safeEqual(signature, sign(secret, body, context))
  ) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function sign(secret: string, body: string, context: string): string {
  return createHmac('sha256', secret)
    .update(context ? `${context}.${body}` : body)
    .digest('base64url');
}
