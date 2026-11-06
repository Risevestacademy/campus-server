import type { AccountLookup, Appearance } from '../../infra/accounts.js';
import type { Player } from '../../movement/players.js';
import type { Connection } from '../connections.js';
import type { WorldContext } from '../context.js';
import type { Avatar } from '../protocol.js';

type AppearanceContext = Pick<
  WorldContext,
  'app' | 'connections' | 'players' | 'broadcast'
>;

export function avatarOf(player: Player, connection: Connection): Avatar {
  const until = connection.availability.shownUntil;
  return {
    ...player,
    ...connection.appearance,
    status: connection.availability.shown,
    statusUntil: until === null ? null : new Date(until).toISOString(),
    spaceKey: connection.spaceKey,
  };
}

export type AppearanceFeature = ReturnType<typeof createAppearance>;

export function createAppearance(
  ctx: AppearanceContext,
  accounts: AccountLookup,
) {
  const { app, connections, players, broadcast } = ctx;

  /**
   * Puts the account's sprite and name on one of its sockets, and tells that
   * socket's cohort, itself included, when they differ from what was being
   * drawn there. Only for a socket that still holds the account's place in
   * its cohort: the read crossed an await, and a socket replaced meanwhile
   * has nobody left to tell.
   */
  function show(connection: Connection, account: Appearance): void {
    if (!connections.has(connection)) {
      return;
    }
    const { displayName, spriteKey } = account;
    if (
      connection.appearance.displayName === displayName &&
      connection.appearance.spriteKey === spriteKey
    ) {
      return;
    }
    connection.appearance = { displayName, spriteKey };
    broadcast(connection.cohortId, {
      type: 'appearance',
      userId: connection.userId,
      displayName,
      spriteKey,
    });
  }

  /** Everybody standing in one cohort's campus, with what to draw for them. */
  function avatarsIn(cohortId: string): Avatar[] {
    return players.in(cohortId).flatMap((player) => {
      const connection = connections.holderOf({
        userId: player.userId,
        cohortId,
      });
      return connection ? [avatarOf(player, connection)] : [];
    });
  }

  async function changed(userId: string): Promise<void> {
    if (connections.forUser(userId).length === 0) {
      return; // Not on this process's campus: nobody here to tell.
    }
    let account;
    try {
      account = await accounts.find(userId);
    } catch (err) {
      // The heartbeat reads the account again and catches it then.
      app.log.error({ err, userId }, 'could not re-read a changed profile');
      return;
    }
    if (account) {
      // Every cohort they are standing in is told, each once.
      for (const connection of connections.forUser(userId)) {
        show(connection, account);
      }
    }
  }

  return { show, avatarsIn, changed };
}
