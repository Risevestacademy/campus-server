import { z } from 'zod';

import { Direction } from '../movement/grid.js';
import type { MoveOutcome, Player } from '../movement/players.js';

/**
 * Every frame is one JSON envelope: a type, and a payload the type decides.
 * Parsed at the edge, so nothing past this file handles a shape it did not
 * ask for. JSON while the traffic is small; the envelope leaves room to move
 * position updates to a binary frame later without renaming anything.
 */
export const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({
    type: z.literal('move'),
    /** Which way, never where to: the server works out the tile. */
    direction: z.enum(Direction),
    /**
     * The client's own counter, echoed on the `moveResult` so it can match
     * the answer to the step it already drew and correct only that one.
     */
    seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
]);

export type ClientMessage = z.infer<typeof ClientMessage>;

export type ServerMessage =
  | { type: 'welcome'; userId: string; connectionId: string; heartbeatSeconds: number }
  | { type: 'pong' }
  /** Sent once, right after `welcome`: the map, and everybody on it, you included. */
  | { type: 'snapshot'; map: { width: number; height: number }; players: Player[] }
  /** Somebody arrived. Not sent for a second tab of somebody already here. */
  | { type: 'joined'; player: Player }
  /** Somebody's last socket closed. */
  | { type: 'left'; userId: string }
  /**
   * Somebody moved or turned. Sent to every socket but the one that asked,
   * which gets a `moveResult` instead — including the mover's other tabs, so
   * they follow along.
   */
  | { type: 'moved'; player: Player }
  /**
   * The answer to one `move`, always sent. `player` is where the server has
   * them: on anything but `moved`, the client snaps back to it.
   */
  | { type: 'moveResult'; seq: number; outcome: MoveOutcome; player: Player }
  | { type: 'error'; code: ServerErrorCode; message: string };

/**
 * No TOO_LARGE: ws enforces maxPayload itself and closes the socket with
 * 1009 before an oversized frame is ever delivered here, so an envelope for
 * it would be unreachable.
 */
export const ServerErrorCode = {
  Unauthorized: 'UNAUTHORIZED',
  BadMessage: 'BAD_MESSAGE',
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
