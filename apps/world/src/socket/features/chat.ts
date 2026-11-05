import { randomUUID } from 'node:crypto';

import {
  DEFAULT_SUBSCRIBE_RADIUS,
  type WorldSpace,
} from '../../infra/accounts.js';
import { seatKey, type Seat } from '../../seat.js';
import type { Connection } from '../connections.js';
import type { WorldContext } from '../context.js';
import { SayBudget, inEarshot, type Hearing } from '../earshot.js';
import { ServerErrorCode, encode } from '../protocol.js';

type ChatContext = Pick<
  WorldContext,
  'connections' | 'players' | 'send' | 'sendFrame'
>;

export type Chat = ReturnType<typeof createChat>;

export function createChat(
  ctx: ChatContext,
  spaceOf: (spaceKey: string) => WorldSpace | undefined,
) {
  const { connections, players, send, sendFrame } = ctx;
  /** One per seat, so a watcher and the avatar it speaks for share it. */
  const budgets = new Map<string, SayBudget>();

  function budgetOf(seat: Seat, now: number): SayBudget {
    const key = seatKey(seat);
    let budget = budgets.get(key);
    if (!budget) {
      budget = new SayBudget(now);
      budgets.set(key, budget);
    }
    return budget;
  }

  /**
   * Relays a line of chat to whoever can hear the speaker, and back to the
   * speaker. A space with no row yet is heard by distance, at the default
   * radius. Never stored, and never logged: what people say is theirs.
   */
  function say(from: Connection, text: string): void {
    const connection = connections.holderOf(from);
    const speaker = connection && players.get(connection);
    if (!connection || !speaker) {
      send(from.socket, {
        type: 'error',
        code: ServerErrorCode.NotAllowed,
        message: 'not on campus: enter it to speak',
      });
      return;
    }
    const now = Date.now();
    if (!budgetOf(connection, now).admit(now)) {
      send(from.socket, {
        type: 'error',
        code: ServerErrorCode.NotAllowed,
        message: 'saying too much too fast',
      });
      return;
    }
    const space = spaceOf(connection.spaceKey);
    const hearing: Hearing =
      space && space.audioMode !== 'proximity'
        ? { kind: 'room' }
        : {
            kind: 'proximity',
            radius: space?.subscribeRadius ?? DEFAULT_SUBSCRIBE_RADIUS,
          };
    const others = connections.all().flatMap((other) => {
      if (other.cohortId !== connection.cohortId || other === connection) {
        return [];
      }
      const player = players.get(other);
      return player
        ? [{ connection: other, ...player, spaceKey: other.spaceKey }]
        : [];
    });
    const frame = encode({
      type: 'said',
      id: randomUUID(),
      userId: connection.userId,
      spaceKey: connection.spaceKey,
      text,
      at: new Date().toISOString(),
    });
    const deliver = (to: Connection): void => {
      sendFrame(to.socket, frame);
      for (const watcher of connections.watchersOf(to)) {
        sendFrame(watcher.socket, frame);
      }
    };
    deliver(connection);
    for (const listener of inEarshot(
      { ...speaker, spaceKey: connection.spaceKey },
      others,
      hearing,
    )) {
      deliver(listener.connection);
    }
  }

  /** Once nobody is left on the seat to speak from it. */
  function forget(seat: Seat): void {
    if (connections.holderOf(seat) || connections.watchersOf(seat).length > 0) {
      return;
    }
    budgets.delete(seatKey(seat));
  }

  return { say, forget };
}
