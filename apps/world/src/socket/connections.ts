import type { CohortMembershipFacts, PersonFacts } from '@campus/space-access';
import type { WebSocket } from 'ws';

import type { Appearance } from '../infra/accounts.js';
import { SeatMap, seatKey, type Seat } from '../seat.js';
import type { Availability } from '../status/availability.js';

/** A space's call as a socket is told it, short of the token. */
export interface CallSpec {
  room: string;
  hearing: 'room' | 'proximity';
  audibleRadius: number;
  subscribeRadius: number;
}

/**
 * avatar: stands for the account on the map. watcher: sees the cohort and
 * may set the avatar's status and speak as it, but has no avatar of its own.
 */
export type ConnectionMode = 'avatar' | 'watcher';

/**
 * take: entering takes the avatar, displacing whoever held it. ifFree: only
 * when nobody holds it, else a watcher; displaced later, it is demoted to a
 * watcher rather than closed.
 */
export type EnterMode = 'take' | 'ifFree';

export interface Connection {
  id: string;
  userId: string;
  email: string;
  cohortId: string;
  mode: ConnectionMode;
  enter: EnterMode;
  /** As the account was when this socket opened, updated as it changes. */
  appearance: Appearance;
  /**
   * The space this socket's avatar stands in: a drawn space's key, or the
   * map's default space. Updated as the avatar crosses from one to another.
   */
  spaceKey: string;
  /** Lives and dies with this socket, unlike appearance. */
  availability: Availability;
  /**
   * `users.system_role` as the account row last said: read at the upgrade,
   * then again every heartbeat. What a space's door reads for an admin, and
   * for a list entry naming a system role.
   */
  systemRole: string;
  /**
   * Their `cohort_members` row in this socket's cohort, as it stood at the
   * upgrade and then at each heartbeat; null if none was read. The door
   * decides from it, at the moment of each step, whether it is live and what
   * role and track it gives them. Never read for an admin, whom the door
   * admits on their role.
   */
  membership: CohortMembershipFacts | null;
  /** The call this socket was last handed, until it leaves it. */
  call?: CallSpec & { identity: string };
  /** The cohort's broadcast room this socket was handed, and whether it may speak there. */
  broadcast?: { room: string; identity: string; canSpeak: boolean };
  /** Whom the last `nearby` named. */
  nearby: ReadonlySet<string>;
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
  private readonly held = new SeatMap<Connection>();
  /** By seat: watchers never hold the account's place. */
  private readonly watchers = new Map<string, Set<Connection>>();

  /**
   * Takes the account's place in this connection's cohort and returns
   * whatever held it before. Its places in other cohorts are untouched.
   */
  add(connection: Connection): Connection | undefined {
    const displaced = this.held.get(connection);
    this.held.set(connection, connection);
    return displaced === connection ? undefined : displaced;
  }

  /**
   * Identity-checked: a displaced socket's close event arrives after its
   * replacement has registered, and removing by account and cohort alone
   * would take the live socket out from under it.
   */
  remove(connection: Connection): void {
    if (this.held.get(connection) === connection) {
      this.held.delete(connection);
    }
  }

  has(connection: Connection): boolean {
    return this.held.get(connection) === connection;
  }

  /** The socket holding the account's place in one cohort. */
  holderOf(seat: Seat): Connection | undefined {
    return this.held.get(seat);
  }

  /** Every socket the account holds, one per cohort it is in. */
  forUser(userId: string): Connection[] {
    return [...this.held.ofAccount(userId)];
  }

  all(): Connection[] {
    return [...this.held.values()];
  }

  addWatcher(connection: Connection): void {
    const key = seatKey(connection);
    let watching = this.watchers.get(key);
    if (!watching) {
      watching = new Set();
      this.watchers.set(key, watching);
    }
    watching.add(connection);
  }

  removeWatcher(connection: Connection): void {
    const key = seatKey(connection);
    const watching = this.watchers.get(key);
    if (!watching?.delete(connection)) return;
    if (watching.size === 0) this.watchers.delete(key);
  }

  isWatching(connection: Connection): boolean {
    return this.watchers.get(seatKey(connection))?.has(connection) ?? false;
  }

  /** Holds the avatar, or watches. */
  isOpen(connection: Connection): boolean {
    return this.has(connection) || this.isWatching(connection);
  }

  watchersOf(seat: Seat): Connection[] {
    return [...(this.watchers.get(seatKey(seat)) ?? [])];
  }

  watchersIn(cohortId: string): Connection[] {
    return this.allWatchers().filter((w) => w.cohortId === cohortId);
  }

  watchersForUser(userId: string): Connection[] {
    return this.allWatchers().filter((w) => w.userId === userId);
  }

  allWatchers(): Connection[] {
    return [...this.watchers.values()].flatMap((watching) => [...watching]);
  }

  /** Holders and watchers alike: whoever a sweep or a shutdown has to reach. */
  everyone(): Connection[] {
    return [...this.all(), ...this.allWatchers()];
  }

  get watcherCount(): number {
    let count = 0;
    for (const watching of this.watchers.values()) count += watching.size;
    return count;
  }

  get size(): number {
    return this.held.size;
  }

  /** Accounts with at least one socket, however many cohorts they are in. */
  get users(): number {
    return this.held.accounts;
  }

  /**
   * How many avatars in one cohort stand in one space. Watchers hold no
   * place on the map, so they never count.
   */
  occupancy(cohortId: string, spaceKey: string): number {
    let count = 0;
    for (const connection of this.held.inCohort(cohortId)) {
      if (connection.spaceKey === spaceKey) count += 1;
    }
    return count;
  }
}

export function personOf(connection: Connection): PersonFacts {
  return {
    userId: connection.userId,
    systemRole: connection.systemRole,
    cohortId: connection.cohortId,
    membership: connection.membership,
  };
}
