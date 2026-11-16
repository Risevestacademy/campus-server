import type { CohortMembershipFacts } from '@campus/space-access';

import type { Account, AccountLookup } from '../../infra/accounts.js';
import { traced } from '../../infra/traced.js';
import { seatKey, type Seat } from '../../seat.js';
import { sessionRefreshedSince } from '../authenticate.js';
import type { Connection } from '../connections.js';
import type { WorldContext } from '../context.js';
import { oneAtATime } from '../one-at-a-time.js';
import type { AppearanceFeature } from './appearance.js';
import type { BroadcastRoom } from './broadcast-room.js';
import type { EntryRequestsFeature } from './entry-requests.js';

type SweepsContext = Pick<
  WorldContext,
  'app' | 'env' | 'connections' | 'closeFor'
>;

export interface SweepDeps {
  appearance: Pick<AppearanceFeature, 'show'>;
  broadcastRoom: Pick<BroadcastRoom, 'isMissing' | 'join'>;
  requests: Pick<EntryRequestsFeature, 'review'>;
  drop(connection: Connection, remember?: boolean): void;
}

export function createSweeps(
  ctx: SweepsContext,
  accounts: AccountLookup,
  { appearance, broadcastRoom, requests, drop }: SweepDeps,
) {
  const { app, env, connections, closeFor } = ctx;

  /**
   * Checked once per heartbeat rather than per frame: a ban, or the end of a
   * guest's visit, should take effect in seconds, and asking the database on
   * every message would put a query in the path of every movement. One query
   * per account, however many cohorts it has sockets in, plus one question
   * for the cohort membership behind every socket that is not an admin's —
   * one query for all of them together, as the session check beside it asks
   * for every login at once.
   */
  async function dropUnwelcome(): Promise<void> {
    const now = new Date();
    const byAccount = new Map<string, Connection[]>();
    for (const connection of connections.everyone()) {
      const open = byAccount.get(connection.userId);
      if (open) open.push(connection);
      else byAccount.set(connection.userId, [connection]);
    }

    // Every account is read before any membership is judged, because who is
    // excepted from the membership question — an admin — is on the account's
    // row. An account the database would not answer for is skipped alone,
    // and its sockets left to the next sweep.
    const known = new Map<string, Account | null>();
    const unasked = new Set<string>();
    for (const userId of byAccount.keys()) {
      try {
        known.set(userId, await accounts.find(userId));
      } catch (err) {
        // A database that is not answering must not throw everybody off the
        // campus; the next sweep tries again.
        app.log.error({ err, userId }, 'could not re-check account');
        unasked.add(userId);
      }
    }

    // The cohort every non-admin socket named, asked again — the upgrade
    // asks once, and nothing behind the socket keeps that answer true: a
    // guest's visit has an end date, and neither the access token the socket
    // opened with nor the login it follows runs out with it. So a membership
    // that ends while the socket is open has to reach that socket, within
    // one heartbeat — and asked once for every socket together, however
    // many are open, as the sessions beside it are.
    let members: Set<string> | undefined;
    const toAsk: Seat[] = [];
    for (const [userId, open] of byAccount) {
      const account = known.get(userId);
      if (!account || account.suspended || account.admin) continue;
      toAsk.push(...open);
    }
    let rows: Map<string, CohortMembershipFacts> | undefined;
    if (toAsk.length > 0) {
      try {
        members = await accounts.liveMemberships(toAsk, now);
      } catch (err) {
        // As with accounts: a database that is not answering must not throw
        // everybody off the campus. Membership stands as the last answer
        // left it, and the next sweep asks again.
        app.log.error({ err }, 'could not re-check membership');
      }
      // What the doors read: a track moved or a role changed reaches them
      // here, a heartbeat late at worst. Kept as they were when unread.
      try {
        rows = await accounts.memberships(toAsk);
      } catch (err) {
        app.log.error({ err }, 'could not re-read memberships for the doors');
      }
    }

    for (const [userId, open] of byAccount) {
      if (unasked.has(userId)) continue;
      const account = known.get(userId) ?? null;
      if (account && !account.suspended) {
        for (const connection of open) {
          dropIfRevoked(connection, account.sessionEpoch);
          // The account was read anyway. A change whose notification this
          // process missed, while it was reconnecting to the database, is
          // caught here, a heartbeat late at worst.
          appearance.show(connection, account);
          connection.systemRole = account.systemRole;
          // Made or unmade an admin: a new token, to speak or only listen.
          // Or the last one could not be minted: try again.
          if (
            connection.mode === 'avatar' &&
            (broadcastRoom.isMissing(connection) ||
              (connection.broadcast &&
                connection.broadcast.canSpeak !== account.admin))
          ) {
            void broadcastRoom.join(connection);
          }
          if (!account.admin && rows !== undefined) {
            connection.membership = rows.get(seatKey(connection)) ?? null;
          }
          // The cohort is asked again for everybody but an admin, who is
          // admitted on their role alone — from the row, as at the upgrade,
          // so a demotion lands on the socket already open too. The answer
          // came from the one query above; when the database gave none,
          // membership stands and the next sweep tries again.
          if (!account.admin && members !== undefined) {
            dropIfNotMember(connection, members.has(seatKey(connection)));
          }
        }
        continue;
      }

      // The account itself is not welcome, so neither is any socket it holds,
      // in any cohort.
      const reason = account ? 'account_suspended' : 'account_gone';
      for (const connection of open) {
        app.log.info(
          {
            connectionId: connection.id,
            userId,
            cohortId: connection.cohortId,
            reason,
          },
          'closing socket, account no longer welcome',
        );
        drop(connection, false);
        closeFor(connection.socket, reason);
      }
    }
    requests.review();
  }

  /**
   * Closes a socket that was opened before its account's sessions were
   * revoked. The upgrade refuses a revoked token; this is what reaches the
   * socket already open, which would otherwise stay until the login stopped
   * being refreshed.
   *
   * Only one that is behind the account's epoch. Somebody who signed in
   * again after the revoke opened on the new epoch, and is as current as it
   * gets.
   *
   * And only one that still holds the account's place in its cohort. The
   * account was read across an await, and in that time a newer socket in the
   * same cohort may have displaced this one — which has then been told
   * `replaced` and closed already, and has nothing left to drop.
   */
  function dropIfRevoked(connection: Connection, sessionEpoch: number): void {
    if (connection.epoch === sessionEpoch || !connections.isOpen(connection)) {
      return;
    }
    app.log.info(
      { connectionId: connection.id, userId: connection.userId },
      'session revoked, closing socket',
    );
    // Remembered, like a sign-out: the account is still welcome, and signing
    // back in may resume where they stood.
    drop(connection);
    closeFor(connection.socket, 'session_revoked');
  }

  /**
   * Applies the sweep's membership answer to one socket: a seat among the
   * live ones stays. Admins are excepted by the caller, as they are at the
   * upgrade.
   *
   * And only one that still holds the account's place in its cohort, for the
   * same reason as dropIfRevoked: the answer was asked for every socket at
   * once and crossed an await, and in that time a newer socket may have
   * displaced this one — which has then been told `replaced` and closed
   * already, with nothing left to drop.
   */
  function dropIfNotMember(connection: Connection, live: boolean): void {
    if (live || !connections.isOpen(connection)) {
      return;
    }

    app.log.info(
      {
        connectionId: connection.id,
        userId: connection.userId,
        cohortId: connection.cohortId,
      },
      'membership ended, closing socket',
    );
    // Remembered, unlike a suspension: a visit may be extended, or the account
    // may belong here again, and then signing back in resumes where they
    // stood rather than starting over. The same reason an upgrade refused for
    // this leaves the kept position alone.
    drop(connection);
    closeFor(connection.socket, 'not_a_member');
  }

  /**
   * An access token lasts fifteen minutes and the browser swaps it for a new
   * one through campus-api, which an open socket never sees. So a socket
   * follows the login instead: it stays while that login is live — not
   * signed out, and refreshed recently, which means campus-api has re-checked
   * suspension and access within the window. One query for every socket.
   */
  async function dropEndedSessions(): Promise<void> {
    const following = connections
      .everyone()
      .filter((c) => c.sessionId !== undefined);
    if (following.length === 0) {
      return;
    }
    const now = new Date();
    let live: Set<string>;
    try {
      live = await accounts.liveSessions(
        following.map((c) => c.sessionId as string),
        sessionRefreshedSince(env, now),
        now,
      );
    } catch (err) {
      // As with accounts: a database that is not answering must not throw
      // everybody off the campus. The next sweep tries again.
      app.log.error({ err }, 'could not re-check sessions');
      return;
    }

    for (const connection of following) {
      if (live.has(connection.sessionId as string)) {
        continue;
      }
      app.log.info(
        { connectionId: connection.id, userId: connection.userId },
        'session ended, closing socket',
      );
      // Remembered: signing out is not access being taken away, and signing
      // straight back in may resume where they stood.
      drop(connection);
      closeFor(connection.socket, 'session_ended');
    }
  }

  /**
   * One of each sweep at a time. The heartbeat does not wait for them, so a
   * database slower than the interval would otherwise stack queries on the
   * pool, and let an older check land after a newer one. A heartbeat that
   * finds its sweep still running skips it; the next one runs with fresh
   * state.
   */
  const sweepFailed = (err: unknown): void => {
    app.log.error({ err }, 'heartbeat sweep failed');
  };
  const sweepUnwelcome = oneAtATime(
    () => traced('world.sweep.accounts', dropUnwelcome),
    sweepFailed,
  );
  const sweepSessions = oneAtATime(
    () => traced('world.sweep.sessions', dropEndedSessions),
    sweepFailed,
  );

  return {
    run(): void {
      sweepUnwelcome();
      sweepSessions();
    },
  };
}
