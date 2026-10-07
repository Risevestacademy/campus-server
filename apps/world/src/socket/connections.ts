import type { WebSocket } from 'ws';

export interface Connection {
  id: string;
  userId: string;
  email: string;
  cohortId: string;
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
  /** In ms. Across instances, the newest connection holds the account. */
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
 * One socket per account: a second one displaces the first rather than
 * joining it.
 */
export class Connections {
  private readonly byUser = new Map<string, Connection>();

  /** Takes the account's place and returns whatever held it before. */
  add(connection: Connection): Connection | undefined {
    const displaced = this.byUser.get(connection.userId);
    this.byUser.set(connection.userId, connection);
    return displaced === connection ? undefined : displaced;
  }

  /**
   * Identity-checked: a displaced socket's close event arrives after its
   * replacement has registered, and removing by account alone would take the
   * live socket out from under it.
   */
  remove(connection: Connection): void {
    if (this.byUser.get(connection.userId) === connection) {
      this.byUser.delete(connection.userId);
    }
  }

  has(connection: Connection): boolean {
    return this.byUser.get(connection.userId) === connection;
  }

  forUser(userId: string): Connection | undefined {
    return this.byUser.get(userId);
  }

  all(): Connection[] {
    return [...this.byUser.values()];
  }

  get size(): number {
    return this.byUser.size;
  }

  get users(): number {
    return this.byUser.size;
  }
}
