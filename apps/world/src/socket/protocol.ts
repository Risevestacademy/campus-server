import { DEFAULT_SPACE_KEY } from '@campus/session';
import { z } from 'zod';

import type { Appearance } from '../infra/accounts.js';
import { Direction } from '../movement/grid.js';
import type {
  MoveOutcome as MovementOutcome,
  Player as MovementPlayer,
} from '../movement/players.js';
import { Status } from '../status/availability.js';
import { MAX_SAY_LENGTH } from './earshot.js';

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

export const StatusSchema = z.enum(Status).meta({
  id: 'Status',
  description:
    'Whether somebody can be approached. available: the default. busy: they ' +
    'would rather not be. away: not at the keyboard — chosen, or set for them ' +
    'by the server once they have done nothing for `awayAfterSeconds`, and ' +
    'cleared when they do something again. Lasts as long as their connection.',
});

const spaceKey = z
  .string()
  .describe(
    "The space they are standing in: a drawn space's key, or " +
      `\`${DEFAULT_SPACE_KEY}\` for the corridors and grounds.`,
  );

/**
 * Only where somebody first appears. `moved` and `moveResult` stay a bare
 * Player: they go out every tick, and what to draw changes rarely, so a
 * change has a message of its own (`appearance`, `statusChanged`).
 */
export const Avatar = z
  .object({
    ...Player.shape,
    ...appearance,
    status: StatusSchema,
    spaceKey,
  })
  .meta({
    id: 'Avatar',
    description:
      'Somebody on the map and what to draw for them. A later change to their ' +
      'sprite or name arrives as an `appearance` message, to their status as ' +
      'a `statusChanged`, and to their space as a `spaceChanged`.',
  });

export const Call = z
  .object({
    url: z.string().describe('The media server to connect to.'),
    room: z.string(),
    token: z
      .string()
      .describe('Lets you join this room only, for about ten minutes.'),
    hearing: z
      .enum(['room', 'proximity'])
      .describe(
        'room: subscribe to everybody in it. proximity: subscribe only to ' +
          'the people the latest `nearby` names.',
      ),
    audibleRadius: z
      .number()
      .describe(
        'In tiles, for proximity: fade a voice to nothing across this distance.',
      ),
    subscribeRadius: z
      .number()
      .describe('In tiles, for proximity: how far `nearby` reaches.'),
  })
  .meta({
    id: 'Call',
    description:
      'The audio call for the space you are standing in. A participant’s ' +
      'identity starts with their user id and a colon.',
  });

export const BroadcastCall = z
  .object({
    url: z.string().describe('The media server to connect to.'),
    room: z.string(),
    token: z
      .string()
      .describe(
        'Lets you join this room only: within a minute if you may speak, ' +
          'ten if you only listen. Join with it straight away.',
      ),
    canSpeak: z
      .boolean()
      .describe(
        'You are an admin: you may publish your microphone here, and ' +
          'nothing else. Everybody else only listens.',
      ),
  })
  .meta({
    id: 'BroadcastCall',
    description:
      'Your cohort’s broadcast room, where admins speak to everybody in ' +
      'the campus. Join it beside the call for your space and stay in it ' +
      'wherever you walk. Subscribe to every audio track in it and play ' +
      'it over everything else, with the call for your space carrying on ' +
      'quieter underneath; it cannot be muted. Several admins may speak at ' +
      'once. A broadcast starts and stops as a track is published and ' +
      'unpublished in this room.',
  });

export const MoveOutcome = z
  .enum(['moved', 'blocked', 'refused', 'too_fast'])
  .meta({
    id: 'MoveOutcome',
    description:
      'moved: one tile in the direction asked. blocked: the tile is not ' +
      'walkable; they turn to face it without moving. refused: the tile is ' +
      'floor, but in a space they may not enter (designated and not on its ' +
      'list, or locked); they turn to face it without moving, and may ask with ' +
      '`requestEntry`. too_fast: over walking ' +
      'speed; nothing happens, not even the turn.',
  });

const requestId = z
  .string()
  .describe(
    'This request, not the person asking: asking again gets a new one. ' +
      'Answer and withdraw with it, so a late answer never reaches a newer ' +
      'request.',
  );

export const EntryRequestOutcome = z
  .enum([
    'admitted',
    'declined',
    'withdrawn',
    'walked_away',
    'nobody_inside',
    'not_needed',
    'cancelled',
  ])
  .meta({
    id: 'EntryRequestOutcome',
    description:
      'admitted: a yes. Their next step into the space is let through; ' +
      'walking away from beside it first lets the yes lapse. declined: a ' +
      'no. withdrawn: the asker withdrew it, or disconnected. walked_away: ' +
      'the asker left the tiles beside the space. nobody_inside: nobody ' +
      'inside can answer any more. not_needed: they may walk in without ' +
      'asking now, as the space was unlocked or its list names them. ' +
      'cancelled: the space no longer takes requests.',
  });

/**
 * No TOO_LARGE: ws enforces maxPayload itself and closes the socket with
 * 1009 before an oversized frame is ever delivered here, so an envelope for
 * it would be unreachable.
 */
export const ServerErrorCode = {
  Unauthorized: 'UNAUTHORIZED',
  BadMessage: 'BAD_MESSAGE',
  NotAllowed: 'NOT_ALLOWED',
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
    z
      .object({
        type: z.literal('setStatus'),
        status: StatusSchema,
      })
      .meta({
        id: 'SetStatusMessage',
        description:
          'Choose your status. Answered, if it changes what your cohort sees, ' +
          'by the `statusChanged` everybody in it gets, you included. Counts ' +
          'as activity.',
      }),
    z.object({ type: z.literal('active') }).meta({
      id: 'ActiveMessage',
      description:
        'The person did something the server cannot see — a key, a click, a ' +
        'word in a call. Keeps them from going away while idle, and brings ' +
        'them back if they had. A `move` or `setStatus` counts already; a ' +
        '`ping` does not. No answer.',
    }),
    z
      .object({
        type: z.literal('setLock'),
        locked: z.boolean(),
      })
      .meta({
        id: 'SetLockMessage',
        description:
          'Lock or unlock the space you are standing in, if `lockableSpaces` ' +
          'names it. Anybody inside may, guests included. Answered, if it ' +
          'changes anything, by the `lockChanged` everybody in your cohort ' +
          'gets, you included; in a space that cannot be locked, by a ' +
          'NOT_ALLOWED error. Counts as activity.',
      }),
    z
      .object({
        type: z.literal('requestEntry'),
        spaceKey: z.string(),
      })
      .meta({
        id: 'RequestEntryMessage',
        description:
          'Ask to enter a space you are refused: a locked one, a ' +
          'designated one whose list does not name you, or one staff ' +
          'removed you from in the last 90 seconds. Only from a tile ' +
          'beside it, only while somebody inside can answer, and one request ' +
          'at a time. Answered by `entryRequested`, to you and to whoever ' +
          'inside can answer; otherwise by a NOT_ALLOWED error saying why. ' +
          'After a no, the same space can be asked again 30 seconds later. ' +
          'Counts as activity.',
      }),
    z.object({ type: z.literal('withdrawEntryRequest'), requestId }).meta({
      id: 'WithdrawEntryRequestMessage',
      description:
        'Withdraw your open request, answered by its `entryRequestEnded`. ' +
        'A `requestId` that is not your open request, as one that has ' +
        'ended, gets a NOT_ALLOWED error. Counts as activity.',
    }),
    z
      .object({
        type: z.literal('answerEntryRequest'),
        requestId,
        admit: z.boolean(),
      })
      .meta({
        id: 'AnswerEntryRequestMessage',
        description:
          'Answer a request to enter the space you are standing in. Anybody ' +
          'inside a locked space may; in a designated space, only somebody ' +
          'its list names, or an admin. The first answer stands: one that ' +
          'comes later, names a request that has ended, or comes from ' +
          'somebody who may not answer, gets a NOT_ALLOWED error. Counts as ' +
          'activity.',
      }),
    z
      .object({
        type: z.literal('say'),
        text: z.string().trim().min(1).max(MAX_SAY_LENGTH),
      })
      .meta({
        id: 'SayMessage',
        description:
          'A line of chat to whoever can hear you: everybody in a whole-room ' +
          'space, or the people within its subscribe radius in a proximity ' +
          'space, measured when you send it, without the hysteresis `nearby` ' +
          'keeps, so the two need not match at the edge. Up to ' +
          `${MAX_SAY_LENGTH} characters, trimmed. ` +
          'Answered by the `said` you and they get; five lines at once, then ' +
          'one a second, after which a NOT_ALLOWED error. Never stored. ' +
          'Counts as activity.',
      }),
    z
      .object({
        type: z.literal('mute'),
        userId: z.string().describe('Whose microphone to switch off.'),
      })
      .meta({
        id: 'MuteMessage',
        description:
          'Staff only: switch off somebody’s microphone in the call for ' +
          'their space, once; they may switch it back on. An admin may mute ' +
          'anybody in the cohort’s campus; a professor or mentor only ' +
          'somebody in the designated space they stand in, whose list names ' +
          'them. Never an admin, never yourself. Answered by `staffAction`, ' +
          'to you and to them; otherwise by a NOT_ALLOWED error saying why. ' +
          'Counts as activity.',
      }),
    z
      .object({
        type: z.literal('removeFromSpace'),
        userId: z
          .string()
          .describe('Whom to remove from the space they stand in.'),
      })
      .meta({
        id: 'RemoveFromSpaceMessage',
        description:
          'Staff only, the same staff as for `mute`: move somebody out of ' +
          'the space they stand in, to the nearest tile outside it, and keep ' +
          'them out for 90 seconds; they may ask to enter meanwhile. Not ' +
          'from the corridors. Answered by `staffAction`, to you and to ' +
          'them; otherwise by a NOT_ALLOWED error saying why. Counts as ' +
          'activity.',
      }),
  ])
  .meta({ id: 'ClientMessage', description: 'Every frame a client may send.' });

export type ClientMessage = z.infer<typeof ClientMessage>;

export type EntryRequestOutcome = z.infer<typeof EntryRequestOutcome>;

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
        awayAfterSeconds: z
          .number()
          .int()
          .describe(
            'How long you may do nothing before the server shows you away. ' +
              'Send `active` well within it while the person is there. 0 when ' +
              'this deployment never does.',
          ),
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
        lockableSpaces: z
          .array(z.string())
          .describe(
            'The spaces whoever stands inside may lock. No other space can ' +
              'be, nor the corridors. The same in every cohort.',
          ),
        lockedSpaces: z
          .array(z.string())
          .describe('The spaces locked in your cohort right now.'),
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
    z
      .object({
        type: z.literal('statusChanged'),
        userId: z.string(),
        status: StatusSchema,
      })
      .meta({
        id: 'StatusChangedMessage',
        description:
          "Somebody in your cohort's status changed: chosen, or set to away " +
          'while idle and back again. Sent to everybody in the cohort, you ' +
          'included when it is yours.',
      }),
    z
      .object({
        type: z.literal('spaceChanged'),
        userId: z.string(),
        spaceKey,
      })
      .meta({
        id: 'SpaceChangedMessage',
        description:
          'Somebody in your cohort stepped into another space. Sent to ' +
          'everybody in the cohort, you included when it is you, the moment ' +
          'the step is taken: it can arrive before the `moved` that shows ' +
          'the step.',
      }),
    z.object({ type: z.literal('call'), call: Call.nullable() }).meta({
      id: 'CallMessage',
      description:
        'Sent on arrival and each time you step into another space: leave ' +
        'the call you are in and join this one. Null where there is no ' +
        'call to join.',
    }),
    z
      .object({ type: z.literal('broadcast'), call: BroadcastCall.nullable() })
      .meta({
        id: 'BroadcastMessage',
        description:
          'Sent on arrival, and again when you are made or stop being an ' +
          'admin: leave the broadcast room you are in and join this one. ' +
          'Null where there is none to join; when a token could not be ' +
          'made, another comes within a heartbeat.',
      }),
    z.object({ type: z.literal('nearby'), userIds: z.array(z.string()) }).meta({
      id: 'NearbyMessage',
      description:
        'In a proximity space, who is close enough to hear, each time ' +
        'that changes: subscribe to their audio and drop everybody ' +
        'else’s. Can arrive before the `call` it applies to.',
    }),
    z
      .object({
        type: z.literal('lockChanged'),
        spaceKey: z.string(),
        locked: z.boolean(),
        userId: z
          .string()
          .nullable()
          .describe(
            'Who locked or unlocked it. Null when the lock ended on its ' +
              'own: the last person inside left, or the space can no longer ' +
              'be locked.',
          ),
      })
      .meta({
        id: 'LockChangedMessage',
        description:
          'A space in your cohort was locked or unlocked. While it is ' +
          'locked, a step into it is refused, admins excepted. Sent to ' +
          'everybody in the cohort, you included.',
      }),
    z
      .object({
        type: z.literal('lockableSpaces'),
        spaceKeys: z.array(z.string()),
      })
      .meta({
        id: 'LockableSpacesMessage',
        description:
          'Which spaces can be locked changed, because an admin changed a ' +
          'space: replaces the list from `snapshot`.',
      }),
    z
      .object({
        type: z.literal('entryRequested'),
        requestId,
        userId: z.string().describe('Who is asking.'),
        spaceKey: z.string(),
      })
      .meta({
        id: 'EntryRequestedMessage',
        description:
          'Somebody asks to enter a space. Sent to the asker, and to each ' +
          'person inside who may answer, as they become able to: on the ' +
          'request, or on stepping in later. Every one is followed by an ' +
          '`entryRequestEnded` with the same `requestId`. Only answerable ' +
          'while you stand in that space.',
      }),
    z
      .object({
        type: z.literal('entryRequestEnded'),
        requestId,
        userId: z.string().describe('Who asked.'),
        spaceKey: z.string(),
        outcome: EntryRequestOutcome,
        answeredBy: z
          .string()
          .nullable()
          .describe('Who said yes or no. Null for every other outcome.'),
      })
      .meta({
        id: 'EntryRequestEndedMessage',
        description:
          'A request to enter is over. Sent to the asker and to everybody ' +
          'who was sent its `entryRequested`.',
      }),
    z
      .object({
        type: z.literal('said'),
        id: z.string().describe('Unique to this line.'),
        userId: z.string().describe('Who said it.'),
        spaceKey: z
          .string()
          .describe(
            'The space they said it in, so a meeting’s chat can be kept apart.',
          ),
        text: z.string(),
        at: z.string().describe('When world relayed it, as an ISO timestamp.'),
      })
      .meta({
        id: 'SaidMessage',
        description:
          'A line of chat from somebody who could be heard where you stand ' +
          'when they said it, or your own. World keeps none of it: a line ' +
          'reaches whoever is in earshot at that moment and nobody later.',
      }),
    z
      .object({
        type: z.literal('staffAction'),
        action: z
          .enum(['muted', 'removed'])
          .describe(
            'muted: their microphone was switched off; they may switch it ' +
              'on again. removed: they were moved out of the space and are ' +
              'kept out until `until`.',
          ),
        userId: z.string().describe('Whom it was done to.'),
        by: z.string().describe('The staff member who did it.'),
        spaceKey: z.string().describe('The space it was done in.'),
        until: z
          .string()
          .nullable()
          .describe(
            'For removed: when they may walk back in, as an ISO timestamp. ' +
              'Null for muted.',
          ),
        player: Player.nullable().describe(
          'For removed: where they stand now, outside the space. Snap them ' +
            'there. Null for muted.',
        ),
      })
      .meta({
        id: 'StaffActionMessage',
        description:
          'Staff muted somebody or removed them from a space. Sent to the ' +
          'person it was done to and to the staff member who did it. Their ' +
          'cohort sees a removal as a `moved` and a `spaceChanged`.',
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
          'being the reason. BAD_MESSAGE leaves the socket open. NOT_ALLOWED ' +
          'answers a message the server understood but will not act on, and ' +
          'leaves the socket open.',
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
  Same<
    z.infer<typeof Avatar>,
    MovementPlayer & Appearance & { status: Status; spaceKey: string }
  >
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
