import { randomUUID } from 'node:crypto';

import {
  DEFAULT_SUBSCRIBE_RADIUS,
  type WorldSpace,
} from '../../infra/accounts.js';
import type { Connection } from '../connections.js';
import type { WorldContext } from '../context.js';
import { inEarshot, type Hearing, type SayBudget } from '../earshot.js';
import { ServerErrorCode, encode } from '../protocol.js';

type ChatContext = Pick<
  WorldContext,
  'connections' | 'players' | 'send' | 'sendFrame'
>;

export function createChat(
  ctx: ChatContext,
  spaceOf: (spaceKey: string) => WorldSpace | undefined,
) {
  const { connections, players, send, sendFrame } = ctx;

  /**
   * Relays a line of chat to whoever can hear the speaker, and back to the
   * speaker. A space with no row yet is heard by distance, at the default
   * radius. Never stored, and never logged: what people say is theirs.
   */
  function say(connection: Connection, text: string, budget: SayBudget): void {
    if (!budget.admit(Date.now())) {
      send(connection.socket, {
        type: 'error',
        code: ServerErrorCode.NotAllowed,
        message: 'saying too much too fast',
      });
      return;
    }
    const speaker = players.get(connection);
    if (!speaker) return;
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
    sendFrame(connection.socket, frame);
    for (const listener of inEarshot(
      { ...speaker, spaceKey: connection.spaceKey },
      others,
      hearing,
    )) {
      sendFrame(listener.connection.socket, frame);
    }
  }

  return { say };
}
