import type { WebSocket } from 'ws';

export interface Connection {
  id: string;
  userId: string;
  email: string;
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
 * Keyed by user because a person may have two tabs, and a message for them
 * belongs on both.
 */
export class Connections {
  private readonly byUser = new Map<string, Set<Connection>>();

  add(connection: Connection): void {
    const existing = this.byUser.get(connection.userId);
    if (existing) {
      existing.add(connection);
      return;
    }
    this.byUser.set(connection.userId, new Set([connection]));
  }

  remove(connection: Connection): void {
    const held = this.byUser.get(connection.userId);
    if (!held) {
      return;
    }
    held.delete(connection);
    if (held.size === 0) {
      this.byUser.delete(connection.userId);
    }
  }

  has(connection: Connection): boolean {
    return this.byUser.get(connection.userId)?.has(connection) ?? false;
  }

  forUser(userId: string): Connection[] {
    return [...(this.byUser.get(userId) ?? [])];
  }

  all(): Connection[] {
    return [...this.byUser.values()].flatMap((set) => [...set]);
  }

  get size(): number {
    return this.all().length;
  }

  get users(): number {
    return this.byUser.size;
  }
}
