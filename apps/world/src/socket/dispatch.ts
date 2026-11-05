import type { Tile } from '../movement/grid.js';
import type { Connection } from './connections.js';
import type { WorldContext } from './context.js';
import { SayBudget } from './earshot.js';
import type { Chat } from './features/chat.js';
import type { EntryRequestsFeature } from './features/entry-requests.js';
import type { Locks } from './features/locks.js';
import type { Moderation } from './features/moderation.js';
import type { PresenceSync } from './features/presence.js';
import type { Walks } from './features/walks.js';
import { FrameBudget } from './frame-budget.js';
import { ServerErrorCode, decode } from './protocol.js';

type DispatchContext = Pick<
  WorldContext,
  'app' | 'env' | 'connections' | 'players' | 'metrics' | 'send' | 'closeFor'
>;

export interface DispatchDeps {
  presence: Pick<PresenceSync, 'noteActivity' | 'statusChanged'>;
  locks: Pick<Locks, 'setLock'>;
  requests: Pick<EntryRequestsFeature, 'request' | 'withdraw' | 'answer'>;
  chat: Chat;
  moderation: Pick<Moderation, 'mute' | 'remove'>;
  walks: Pick<Walks, 'goTo' | 'goToSpace' | 'goToTile' | 'end' | 'admitsStep'>;
  drop(connection: Connection): void;
  noteMoved(connection: Connection): void;
  arrivedAt(connection: Connection, tile: Tile): void;
}

/** Reads what an open socket sends, and hands each message to the feature it is for. */
export function createDispatch(ctx: DispatchContext, deps: DispatchDeps) {
  const { app, env, connections, players, metrics, send, closeFor } = ctx;
  const {
    presence,
    locks,
    requests,
    chat,
    moderation,
    walks,
    drop,
    noteMoved,
    arrivedAt,
  } = deps;

  return function listen(connection: Connection): void {
    const ws = connection.socket;
    const budget = new FrameBudget(
      env.WORLD_MAX_MESSAGES_PER_SECOND,
      Date.now(),
    );
    const sayBudget = new SayBudget(Date.now());

    ws.on('message', (raw: Buffer) => {
      // A socket we have dropped can still deliver frames while its close
      // handshake finishes. It no longer speaks for anybody — and its player
      // may be gone, which a move would trip over.
      if (!connections.has(connection)) {
        return;
      }
      // Before parsing, so an excess frame costs only a counter. Closing
      // makes the client reconnect to an authoritative snapshot instead of
      // silently losing a predicted move.
      const admission = budget.admit(Date.now());
      if (admission === 'close') {
        app.log.warn(
          { connectionId: connection.id, userId: connection.userId },
          'socket sending too fast, closing',
        );
        drop(connection);
        closeFor(connection.socket, 'rate_limited');
        return;
      }
      // Frames over WORLD_MAX_MESSAGE_BYTES never arrive: ws enforces
      // maxPayload itself and closes with 1009 before this fires.
      const result = decode(raw.toString('utf8'));
      metrics.received(result.ok ? result.message.type : 'invalid');
      if (!result.ok) {
        send(ws, {
          type: 'error',
          code: ServerErrorCode.BadMessage,
          message: result.reason,
        });
        return;
      }

      switch (result.message.type) {
        case 'ping':
          connection.alive = true;
          send(ws, { type: 'pong' });
          return;
        case 'active':
          presence.noteActivity(connection);
          return;
        case 'setStatus':
          if (
            connection.availability.choose(result.message.status, Date.now())
          ) {
            presence.statusChanged(connection);
          }
          return;
        case 'setLock':
          presence.noteActivity(connection);
          locks.setLock(connection, result.message.locked);
          return;
        case 'requestEntry':
          presence.noteActivity(connection);
          requests.request(connection, result.message.spaceKey);
          return;
        case 'withdrawEntryRequest':
          presence.noteActivity(connection);
          requests.withdraw(connection, result.message.requestId);
          return;
        case 'answerEntryRequest':
          presence.noteActivity(connection);
          requests.answer(
            connection,
            result.message.requestId,
            result.message.admit,
          );
          return;
        case 'say':
          presence.noteActivity(connection);
          chat.say(connection, result.message.text, sayBudget);
          return;
        case 'mute':
          presence.noteActivity(connection);
          void moderation.mute(connection, result.message.userId);
          return;
        case 'removeFromSpace':
          presence.noteActivity(connection);
          moderation.remove(connection, result.message.userId);
          return;
        case 'goTo':
          presence.noteActivity(connection);
          walks.goTo(connection, result.message.userId);
          return;
        case 'goToSpace':
          presence.noteActivity(connection);
          walks.goToSpace(connection, result.message.spaceKey);
          return;
        case 'goToTile':
          presence.noteActivity(connection);
          walks.goToTile(connection, {
            x: result.message.x,
            y: result.message.y,
          });
          return;
        case 'stopWalking':
          presence.noteActivity(connection);
          walks.end(connection, 'stopped');
          return;
        case 'move': {
          presence.noteActivity(connection);
          walks.end(connection, 'stopped');
          const { direction, seq } = result.message;
          const now = Date.now();
          const moved = players.move(
            connection,
            direction,
            now,
            walks.admitsStep(connection, now),
          );
          metrics.moved(moved.outcome);
          send(ws, {
            type: 'moveResult',
            seq,
            outcome: moved.outcome,
            player: moved.player,
          });
          if (moved.outcome === 'moved') arrivedAt(connection, moved.player);
          if (moved.changed) noteMoved(connection);
          return;
        }
      }
    });
  };
}
