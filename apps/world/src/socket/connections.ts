import type { WebSocket } from 'ws';

import type { Appearance } from '../infra/accounts.js';

export interface Connection {
  id: string;
  userId: string;
  email: string;
  cohortId: string;
  /** As the account was when this socket opened, updated as it changes. */
  appearance: Appearance;
  socket: WebSocket;
  /**
   * When the access token this socket opened with runs out. Enforced only
   * when there is no `sessionId` to follow instead.
   */
  expiresAt: Date;
  /**
   * The login (refresh-token family) behind this socket, when the token
   * names one. The socket lives as long as that login is live, however many
   * access tokens the browser goes through meanwhile.
   */
  sessionId?: string;
  /**
   * In ms. Across instances, the newest connection holds the account's place
   * in a cohort.
   */
  openedAt: number;
  /**
   * The account's session epoch when this socket opened. Once the account's
   * moves past it, this socket belongs to a session that has been revoked —
   * while one opened after the bump carries the new epoch and stays.
   */
  epoch: number;
  /** Set false on every heartbeat, true by the client's pong. */
  alive: boolean;
}

/**
 * Who is connected, right now, in this process. Not presence: presence is
 * shared across instances and lives in Redis. This only knows about sockets
 * this process is holding open.
 *
 * One socket per account in each cohort. An account may hold sockets in
 * several cohorts at once; a second one in the same cohort displaces the
 * first rather than joining it.
 */
export class Connections {
  /** Account, then cohort. */
  private readonly byUser = new Map<string, Map<string, Connection>>();

  /**
   * Takes the account's place in this connection's cohort and returns
   * whatever held it before. Its places in other cohorts are untouched.
   */
  add(connection: Connection): Connection | undefined {
    let held = this.byUser.get(connection.userId);
    if (!held) {
      held = new Map();
      this.byUser.set(connection.userId, held);
    }
    const displaced = held.get(connection.cohortId);
    held.set(connection.cohortId, connection);
    return displaced === connection ? undefined : displaced;
  }

  /**
   * Identity-checked: a displaced socket's close event arrives after its
   * replacement has registered, and removing by account and cohort alone
   * would take the live socket out from under it.
   */
  remove(connection: Connection): void {
    const held = this.byUser.get(connection.userId);
    if (held?.get(connection.cohortId) !== connection) {
      return;
    }
    held.delete(connection.cohortId);
    if (held.size === 0) {
      this.byUser.delete(connection.userId);
    }
  }

  has(connection: Connection): boolean {
    return (
      this.byUser.get(connection.userId)?.get(connection.cohortId) ===
      connection
    );
  }

  /** The socket holding the account's place in one cohort. */
  get(userId: string, cohortId: string): Connection | undefined {
    return this.byUser.get(userId)?.get(cohortId);
  }

  /** Every socket the account holds, one per cohort it is in. */
  forUser(userId: string): Connection[] {
    return [...(this.byUser.get(userId)?.values() ?? [])];
  }

  all(): Connection[] {
    return [...this.byUser.values()].flatMap((held) => [...held.values()]);
  }

  get size(): number {
    let count = 0;
    for (const held of this.byUser.values()) count += held.size;
    return count;
  }

  /** Accounts with at least one socket, however many cohorts they are in. */
  get users(): number {
    return this.byUser.size;
  }
}
