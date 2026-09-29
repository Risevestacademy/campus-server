import { z } from 'zod';

import { Direction } from '../movement/grid.js';
import type { MoveOutcome as MovementOutcome, Player as MovementPlayer } from '../movement/players.js';

/*
 * The wire contract, both directions, as zod schemas. Client frames are
 * parsed against them; server frames are only typed by them, never parsed —
 * the server trusts its own output. They are also the source of
 * protocol.schema.json, which the frontend generates its types from, so the
 * descriptions below are written for whoever reads those types.
 */

export const DirectionSchema = z.enum(Direction).meta({
  id: 'Direction',
  description: 'One tile in screen terms: up is y - 1, right is x + 1.',
});

export const Player = z
  .object({
    userId: z.string(),
    x: z.number().int().min(0).describe('Tile column, from 0 at the left edge.'),
    y: z.number().int().min(0).describe('Tile row, from 0 at the top edge.'),
    facing: DirectionSchema,
  })
  .meta({
    id: 'Player',
    description:
      'Somebody on the map, as the server has them. Positions are tiles, never pixels.',
  });

export const MoveOutcome = z.enum(['moved', 'blocked', 'too_fast']).meta({
  id: 'MoveOutcome',
  description:
    'moved: one tile in the direction asked. blocked: the tile is not walkable; ' +
    'they turn to face it without moving. too_fast: over walking speed; nothing ' +
    'happens, not even the turn.',
});

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

/**
 * Every frame is one JSON envelope: a type, and a payload the type decides.
 * Parsed at the edge, so nothing past this file handles a shape it did not
 * ask for. JSON while the traffic is small; the envelope leaves room to move
 * position updates to a binary frame later without renaming anything.
 */
export const ClientMessage = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('ping') }).meta({
      id: 'PingMessage',
      description: 'Answered with `pong`.',
    }),
    z
      .object({
        type: z.literal('move'),
        direction: DirectionSchema.describe(
          'Which way, never where to: the server works out the tile.',
        ),
        seq: z
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER)
          .describe(
            "The client's own counter, echoed on the `moveResult` so it can match " +
              'the answer to the step it already drew.',
          ),
      })
      .meta({
        id: 'MoveMessage',
        description: 'One step. Always answered with a `moveResult`.',
      }),
  ])
  .meta({ id: 'ClientMessage', description: 'Every frame a client may send.' });

export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerMessage = z
  .discriminatedUnion('type', [
    z
      .object({
        type: z.literal('welcome'),
        userId: z.string(),
        connectionId: z.string(),
        heartbeatSeconds: z.number().int(),
        stepMs: z
          .number()
          .int()
          .describe(
            'Walking speed: one tile per this many milliseconds. Animate a step over ' +
              'this long, and send no faster, or moves come back `too_fast`.',
          ),
        tickMs: z
          .number()
          .int()
          .describe('How often `moved` arrives while anybody is moving.'),
      })
      .meta({
        id: 'WelcomeMessage',
        description: 'First frame on a socket that was let in.',
      }),
    z.object({ type: z.literal('pong') }).meta({
      id: 'PongMessage',
      description: 'The answer to a `ping`.',
    }),
    z
      .object({
        type: z.literal('snapshot'),
        map: z.object({ width: z.number().int(), height: z.number().int() }),
        players: z.array(Player),
      })
      .meta({
        id: 'SnapshotMessage',
        description:
          'Sent once, right after `welcome`: the map, and everybody on it, you included.',
      }),
    z.object({ type: z.literal('joined'), player: Player }).meta({
      id: 'JoinedMessage',
      description: 'Somebody arrived. Not sent for a second tab of somebody already here.',
    }),
    z.object({ type: z.literal('left'), userId: z.string() }).meta({
      id: 'LeftMessage',
      description: "Somebody's last socket closed.",
    }),
    z.object({ type: z.literal('moved'), players: z.array(Player) }).meta({
      id: 'MovedMessage',
      description:
        'Everybody who moved or turned since the last tick, once each, as they stand ' +
        'now: two steps inside one tick arrive as the second, so an entry can be more ' +
        'than one tile from where they were. Sent once per tick, and not at all when ' +
        'nobody moved. A tab is left out of its own entry when it made the latest ' +
        'change, since its `moveResult` already says where it ended up; every other ' +
        "tab of the same person gets it, so they follow along.",
    }),
    z
      .object({
        type: z.literal('moveResult'),
        seq: z.number().int(),
        outcome: MoveOutcome,
        player: Player,
      })
      .meta({
        id: 'MoveResultMessage',
        description:
          'The answer to one admitted `move`. `player` is where the server has ' +
          'them; on anything but `moved`, the client snaps back to it.',
      }),
    z
      .object({
        type: z.literal('error'),
        code: z.enum(ServerErrorCode),
        message: z.string(),
      })
      .meta({
        id: 'ErrorMessage',
        description:
          'UNAUTHORIZED comes just before the socket closes with 1008, `message` ' +
          'being the reason. BAD_MESSAGE leaves the socket open.',
      }),
  ])
  .meta({ id: 'ServerMessage', description: 'Every frame the server may send.' });

export type ServerMessage = z.infer<typeof ServerMessage>;

/*
 * movement/ owns Player and MoveOutcome; these schemas describe them on the
 * wire. Checked both ways, so a field added there cannot go out on the wire
 * without appearing in the schema the frontend generates from.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type PlayerMatchesMovement = Assert<Same<z.infer<typeof Player>, MovementPlayer>>;
export type OutcomeMatchesMovement = Assert<Same<z.infer<typeof MoveOutcome>, MovementOutcome>>;

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
