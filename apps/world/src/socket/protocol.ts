import { z } from 'zod';

import type { Appearance } from '../infra/accounts.js';
import { Direction } from '../movement/grid.js';
import type {
  MoveOutcome as MovementOutcome,
  Player as MovementPlayer,
} from '../movement/players.js';

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
    x: z
      .number()
      .int()
      .min(0)
      .describe('Tile column, from 0 at the left edge.'),
    y: z.number().int().min(0).describe('Tile row, from 0 at the top edge.'),
    facing: DirectionSchema,
  })
  .meta({
    id: 'Player',
    description:
      'Somebody on the map, as the server has them. Positions are tiles, never pixels.',
  });

const appearance = {
  displayName: z
    .string()
    .nullable()
    .describe('The name to show beside them. Null when they have set none.'),
  spriteKey: z
    .string()
    .nullable()
    .describe(
      'Which character to draw them as. Null when they have picked none; ' +
        'draw the default then, and for a key you have no sprite for.',
    ),
};

/**
 * Only where somebody first appears. `moved` and `moveResult` stay a bare
 * Player: they go out every tick, and what to draw changes rarely, so a
 * change has a message of its own (`appearance`).
 */
export const Avatar = z.object({ ...Player.shape, ...appearance }).meta({
  id: 'Avatar',
  description:
    'Somebody on the map and what to draw for them. A later change to their ' +
    'sprite or name arrives as an `appearance` message.',
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
        ...appearance,
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
        map: z.object({
          id: z
            .string()
            .describe(
              'Which published map this is. With `version`, what to load: the ' +
                'server enforces exactly that one.',
            ),
          version: z
            .string()
            .describe(
              'The published version the server loaded. Load this version, not ' +
                'the current one: a map published since would have walls the ' +
                'server does not.',
            ),
          width: z.number().int().describe('In tiles.'),
          height: z.number().int().describe('In tiles.'),
        }),
        players: z.array(Avatar),
      })
      .meta({
        id: 'SnapshotMessage',
        description:
          'Sent once, right after `welcome`: the map, and everybody in your cohort ' +
          'on it, you included. Nobody from another cohort is ever in it.',
      }),
    z.object({ type: z.literal('joined'), player: Avatar }).meta({
      id: 'JoinedMessage',
      description:
        'Somebody arrived in your cohort. Not sent when a socket is replaced within the same cohort, ' +
        'because the avatar never left.',
    }),
    z
      .object({
        type: z.literal('appearance'),
        userId: z.string(),
        ...appearance,
      })
      .meta({
        id: 'AppearanceMessage',
        description:
          'Somebody in your cohort changed their sprite or display name, you included: ' +
          'draw them with these from now on. Sent as soon as they save the change.',
      }),
    z.object({ type: z.literal('left'), userId: z.string() }).meta({
      id: 'LeftMessage',
      description:
        "Somebody's socket in your cohort closed. Entering another cohort is not leaving this one.",
    }),
    z.object({ type: z.literal('replaced') }).meta({
      id: 'ReplacedMessage',
      description:
        "This account opened this cohort's campus somewhere else — another device or tab — " +
        'and that connection has taken its place. Being in another cohort never causes this. ' +
        'The socket closes immediately afterwards with 4000 `entered_elsewhere`. Do NOT ' +
        'reconnect: the two connections would replace each other for as long as both ' +
        'stayed open. Show that they are in this campus elsewhere, and reconnect only when ' +
        'they ask to come back here.',
    }),
    z.object({ type: z.literal('moved'), players: z.array(Player) }).meta({
      id: 'MovedMessage',
      description:
        'Everybody in your cohort who moved or turned since the last tick, once each, as they stand ' +
        'now: two steps inside one tick arrive as the second, so an entry can be more ' +
        'than one tile from where they were. Sent once per tick, and not at all when ' +
        'nobody moved. You are never in your own `moved` frame — your `moveResult` ' +
        'already says where you ended up.',
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
  .meta({
    id: 'ServerMessage',
    description: 'Every frame the server may send.',
  });

export type ServerMessage = z.infer<typeof ServerMessage>;

/**
 * The close codes world sends. 1008 is "policy violation", which is what a
 * refusal is; 4000 is world's own, for the one close a client must not
 * reconnect after.
 */
export const CloseCode = {
  GoingAway: 1001,
  PolicyViolation: 1008,
  InternalError: 1011,
  EnteredElsewhere: 4000,
} as const;
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];

/**
 * Every reason world closes a socket with: its code, what it means, and what
 * a client does about it. The one list: the upgrade's refusals, every close
 * in the gateway and the generated schema all come from here, so a reason
 * cannot be renamed or added without the schema, and the clients generated
 * from it, finding out.
 */
export const CLOSES = {
  no_token: {
    code: CloseCode.PolicyViolation,
    meaning: 'No session was sent.',
    action: 'Send them to sign in.',
  },
  token_not_usable: {
    code: CloseCode.PolicyViolation,
    meaning:
      'The session sent is not usable: expired, or signed before a change to what a token carries.',
    action: 'Try a refresh; if that fails, send them to sign in.',
  },
  session_expired: {
    code: CloseCode.PolicyViolation,
    meaning:
      'The access token an open socket opened with ran out, and it follows no sign-in.',
    action: 'Try a refresh; if that fails, send them to sign in.',
  },
  session_ended: {
    code: CloseCode.PolicyViolation,
    meaning: 'Signed out, or the sign-in stopped being refreshed.',
    action: 'Try a refresh; if that fails, send them to sign in.',
  },
  session_revoked: {
    code: CloseCode.PolicyViolation,
    meaning: "The account's sessions were ended on purpose.",
    action: 'Send them to sign in; a refresh will not work.',
  },
  wrong_scope: {
    code: CloseCode.PolicyViolation,
    meaning: 'Still in onboarding.',
    action: 'Send them to onboarding.',
  },
  account_suspended: {
    code: CloseCode.PolicyViolation,
    meaning: 'The account is suspended.',
    action: 'Sign them out; do not reconnect.',
  },
  account_gone: {
    code: CloseCode.PolicyViolation,
    meaning: 'The account no longer exists.',
    action: 'Sign them out; do not reconnect.',
  },
  origin_not_allowed: {
    code: CloseCode.PolicyViolation,
    meaning: "This page's origin is not on world's list.",
    action: 'Configuration; do not retry.',
  },
  no_cohort: {
    code: CloseCode.PolicyViolation,
    meaning: 'The upgrade named no cohortId.',
    action: 'Client bug; do not retry without one.',
  },
  not_a_member: {
    code: CloseCode.PolicyViolation,
    meaning: 'No live membership in the cohort named; admins excepted.',
    action: 'Back to the cohort picker; do not retry.',
  },
  rate_limited: {
    code: CloseCode.PolicyViolation,
    meaning: 'Sustained sending over the message budget.',
    action: 'Client bug; reconnect with backoff.',
  },
  entered_elsewhere: {
    code: CloseCode.EnteredElsewhere,
    meaning: "This account opened this cohort's campus somewhere else.",
    action:
      'Do not reconnect: show that they are in this campus elsewhere, and reconnect only when they ask.',
  },
  'server shutting down': {
    code: CloseCode.GoingAway,
    meaning: 'A deploy or restart.',
    action: 'Reconnect.',
  },
  internal_error: {
    code: CloseCode.InternalError,
    meaning: 'The server could not check the session.',
    action: 'Reconnect with backoff.',
  },
} as const satisfies Record<
  string,
  { code: CloseCode; meaning: string; action: string }
>;
export type CloseReason = keyof typeof CLOSES;

/** The reasons an upgrade, or a connection check, is refused with. */
export const REFUSALS = [
  'origin_not_allowed',
  'no_token',
  'token_not_usable',
  'wrong_scope',
  'account_gone',
  'account_suspended',
  'session_revoked',
  'session_ended',
  'no_cohort',
  'not_a_member',
] as const satisfies readonly CloseReason[];
export type Refusal = (typeof REFUSALS)[number];

const literalsOf = <T extends string | number>(
  values: readonly { value: T; description: string }[],
) =>
  values.map(({ value, description }) =>
    z.literal(value).describe(description),
  ) as unknown as [z.ZodLiteral<T>, z.ZodLiteral<T>, ...z.ZodLiteral<T>[]];

export const CloseReasonSchema = z
  .union(
    literalsOf(
      (Object.keys(CLOSES) as CloseReason[]).map((reason) => ({
        value: reason,
        description: `Close ${CLOSES[reason].code}. ${CLOSES[reason].meaning} ${CLOSES[reason].action}`,
      })),
    ),
  )
  .meta({
    id: 'CloseReason',
    description:
      'The reason world gives when it closes the socket, read from the close event. ' +
      'Each says which code comes with it and what to do. A 1008 reason this list does ' +
      'not have should be treated as "stop": never retry a refusal you do not understand.',
  });

const CODE_DESCRIPTIONS: Record<CloseCode, string> = {
  [CloseCode.GoingAway]: 'A deploy or restart. Reconnect.',
  [CloseCode.PolicyViolation]:
    'A refusal, or access ending on an open socket. What to do depends on the reason: see CloseReason.',
  [CloseCode.InternalError]:
    'The server could not check the session. Reconnect with backoff.',
  [CloseCode.EnteredElsewhere]:
    'The account opened this cohort elsewhere. Do not reconnect.',
};

export const CloseCodeSchema = z
  .union(
    literalsOf(
      Object.values(CloseCode).map((code) => ({
        value: code,
        description: CODE_DESCRIPTIONS[code],
      })),
    ),
  )
  .meta({
    id: 'CloseCode',
    description:
      'The close codes world sends. Two more reach a client without world sending them: ' +
      '1006, from the browser, when the connection is lost, a heartbeat is missed or the ' +
      'client reads too slowly (reconnect with backoff); and 1009, from the socket ' +
      'library, for a frame over the size limit (client bug; reconnect).',
  });

/** Every reason world refuses with is a 1008. */
export type RefusalsArePolicyViolations = Assert<
  Same<(typeof CLOSES)[Refusal]['code'], typeof CloseCode.PolicyViolation>
>;

/*
 * movement/ owns Player and MoveOutcome; these schemas describe them on the
 * wire. Checked both ways, so a field added there cannot go out on the wire
 * without appearing in the schema the frontend generates from.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type PlayerMatchesMovement = Assert<
  Same<z.infer<typeof Player>, MovementPlayer>
>;
export type OutcomeMatchesMovement = Assert<
  Same<z.infer<typeof MoveOutcome>, MovementOutcome>
>;
export type AvatarMatchesAccount = Assert<
  Same<z.infer<typeof Avatar>, MovementPlayer & Appearance>
>;

export type Avatar = z.infer<typeof Avatar>;

export function encode(message: ServerMessage): string {
  return JSON.stringify(message);
}

export type DecodeResult =
  { ok: true; message: ClientMessage } | { ok: false; reason: string };

export function decode(raw: string): DecodeResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }

  const parsed = ClientMessage.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      reason: parsed.error.issues[0]?.message ?? 'unrecognised message',
    };
  }
  return { ok: true, message: parsed.data };
}
