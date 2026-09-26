import type { WebSocket } from 'ws';

export interface Connection {
  id: string;
  userId: string;
  email: string;
  socket: WebSocket;
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
