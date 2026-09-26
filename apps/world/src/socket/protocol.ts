import { z } from 'zod';

/**
 * Every frame is one JSON envelope: a type, and a payload the type decides.
 * Parsed at the edge, so nothing past this file handles a shape it did not
 * ask for. JSON while the traffic is small; the envelope leaves room to move
 * position updates to a binary frame later without renaming anything.
 */
export const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({
    type: z.literal('echo'),
    /** Placeholder until movement lands: proves the round trip end to end. */
    text: z.string().max(280),
  }),
]);

export type ClientMessage = z.infer<typeof ClientMessage>;

export type ServerMessage =
  | { type: 'welcome'; userId: string; connectionId: string; heartbeatSeconds: number }
  | { type: 'pong' }
  | { type: 'echo'; text: string }
  | { type: 'error'; code: ServerErrorCode; message: string };

export const ServerErrorCode = {
  Unauthorized: 'UNAUTHORIZED',
  BadMessage: 'BAD_MESSAGE',
  TooLarge: 'TOO_LARGE',
} as const;

export type ServerErrorCode =
  (typeof ServerErrorCode)[keyof typeof ServerErrorCode];

export function encode(message: ServerMessage): string {
  return JSON.stringify(message);
}

export type DecodeResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; reason: string };

export function decode(raw: string): DecodeResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }

  const parsed = ClientMessage.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues[0]?.message ?? 'unrecognised message' };
  }
  return { ok: true, message: parsed.data };
}
