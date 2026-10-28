import { eq, sql } from 'drizzle-orm';

import {
  REAL_POSTGRES_URL,
  connectRealPostgres,
  unique,
} from '../../infra/database/testing/real-postgres.js';
import { CohortMembersService } from '../cohorts/cohort-members.service.js';
import { SystemRole, users } from '../users/schema.js';
import { UsersService } from '../users/users.service.js';
import { refreshTokens } from './schema.js';
import { SessionIssuer } from './session-issuer.js';

const config = {
  FF_GOOGLE_AUTH_ENABLED: true,
  AUTH_SESSION_TTL_MINUTES: 15,
  AUTH_PROVISIONAL_TTL_MINUTES: 30,
  AUTH_REFRESH_TTL_DAYS: 30,
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_CALLBACK_URL: 'http://localhost:3000/v1/auth/google/callback',
  AUTH_STATE_SECRET: 'a'.repeat(48),
  AUTH_SESSION_SECRET: 'b'.repeat(48),
} as never;

const ROUNDS = 60;

/**
 * A refresh reads the token, the account and the grant before it takes the
 * family lock, so something started at the same instant is done before the
 * refresh reaches the part that matters. Starting the other a little later
 * each round walks it across the refresh, so that some rounds land in the
 * window where the new token is being written.
 */
const after = <T>(ms: number, task: () => Promise<T>): Promise<T> =>
  new Promise((resolve) => setTimeout(resolve, ms)).then(task);
const stagger = (round: number) => (round % 12) * 0.5;

/**
 * What the family lock is for. A refresh mints a new token into the family;
 * something ending the family at the same moment has to end that new token
 * too. Unlocked, the revoke reads the family before the refresh has written
 * its row, misses it, and leaves a live token behind for sessions that were
 * just ended. Each of these races the two for real and looks for a survivor.
 *
 * See real-postgres.ts for why this cannot run on PGlite.
 */
describe.skipIf(!REAL_POSTGRES_URL)(
  'SessionIssuer, two requests at once',
  () => {
    let pg: ReturnType<typeof connectRealPostgres>;
    let issuer: SessionIssuer;

    beforeAll(() => {
      pg = connectRealPostgres();
      issuer = new SessionIssuer(
        config,
        pg.db as never,
        new UsersService(pg.db as never),
        new CohortMembersService(pg.db as never),
      );
    });

    afterAll(async () => {
      await pg.close();
    });

    /** An admin, who is let in on the role alone: no cohort to set up. */
    const signedIn = async () => {
      const [user] = await pg.db
        .insert(users)
        .values({
          email: `refresh-${unique()}@campus.local`,
          systemRole: SystemRole.Admin,
        })
        .returning();
      const session = await issuer.issueFullAccess(user, { endsAt: null });
      return { user, session };
    };

    const liveTokens = async (userId: string) =>
      (
        await pg.db
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.userId, userId))
      ).filter((token) => token.revokedAt === null);

    it('leaves no live token when a sign-out meets a refresh', async () => {
      const survivors: string[] = [];

      for (let round = 0; round < ROUNDS; round += 1) {
        const { user, session } = await signedIn();

        await Promise.allSettled([
          issuer.refreshSession(session.refreshToken),
          after(stagger(round), () =>
            issuer.revokeRefreshToken(session.refreshToken),
          ),
        ]);

        const live = await liveTokens(user.id);
        if (live.length > 0) {
          survivors.push(`round ${round}: ${live.length} live token(s)`);
        }
      }

      expect(survivors).toEqual([]);
    }, 120_000);

    /**
     * Holds the family's rows from a connection of its own, so a refresh
     * that reaches its family lock stops there, inside its transaction and
     * past the epoch check, until released.
     */
    const holdFamily = async (familyId: string) => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let holding!: (pid: number) => void;
      const pid = new Promise<number>((resolve) => (holding = resolve));
      const done = pg.db.transaction(async (tx) => {
        await tx
          .select({ id: refreshTokens.id })
          .from(refreshTokens)
          .where(eq(refreshTokens.familyId, familyId))
          .for('update');
        const [row] = await tx.execute(sql`select pg_backend_pid() as pid`);
        holding(Number(row.pid));
        await released;
      });
      return {
        pid: await pid,
        release: async () => {
          release();
          await done;
        },
      };
    };

    /**
     * Resolves once a backend not in `except` is waiting on any of `pids`, or
     * once `unless` settles, which means it never had to wait.
     */
    const waitingOn = async (
      pids: number[],
      unless: Promise<unknown>,
      except: number[] = [],
    ): Promise<number | null> => {
      let settled = false;
      const stop = () => (settled = true);
      unless.then(stop, stop);
      while (!settled) {
        const rows = await pg.db.execute(
          sql`select pid, pg_blocking_pids(pid) as blockers from pg_stat_activity`,
        );
        const waiting = rows.find(
          (row) =>
            !except.includes(Number(row.pid)) &&
            (row.blockers as number[]).some((pid) => pids.includes(pid)),
        );
        if (waiting) {
          return Number(waiting.pid);
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      return null;
    };

    // Not left to timing like the others: where the revoke has to land moves
    // with the machine, and a stagger that misses it passes whatever the
    // locking. Each round parks the refresh between its epoch check and its
    // commit, starts the revoke-all, and lets the refresh go only once the
    // revoke is waiting too, so every round races the new token being written.
    it('leaves no live token when every session is ended during a refresh', async () => {
      const wrong: string[] = [];

      for (let round = 0; round < ROUNDS; round += 1) {
        const { user, session } = await signedIn();
        const [{ familyId }] = await liveTokens(user.id);

        const hold = await holdFamily(familyId);
        const refresh = issuer.refreshSession(session.refreshToken);
        const refreshPid = (await waitingOn([hold.pid], refresh)) ?? hold.pid;
        const revoke = issuer.revokeAllSessions(user.id);
        await waitingOn([hold.pid, refreshPid], revoke, [refreshPid]);
        await hold.release();
        const [refreshed] = await Promise.allSettled([refresh, revoke]);

        const live = await liveTokens(user.id);
        if (refreshed.status === 'rejected' || live.length > 0) {
          wrong.push(
            `round ${round}: refresh ${refreshed.status}, ${live.length} live token(s)`,
          );
        }
      }

      expect(wrong).toEqual([]);
    }, 120_000);

    // Within the grace window a token presented twice is one client retrying,
    // not a theft, and both are answered. What must not happen is the two
    // tripping over each other: an error from the database, or a family left
    // revoked for what was a retry.
    it('answers both of two refreshes with the same token', async () => {
      const wrong: string[] = [];

      for (let round = 0; round < ROUNDS; round += 1) {
        const { user, session } = await signedIn();

        const results = await Promise.allSettled([
          issuer.refreshSession(session.refreshToken),
          issuer.refreshSession(session.refreshToken),
        ]);

        const failed = results.filter((result) => result.status === 'rejected');
        const live = await liveTokens(user.id);
        if (failed.length > 0 || live.length === 0) {
          wrong.push(
            `round ${round}: ${failed.length} refused, ${live.length} live token(s)`,
          );
        }
      }

      expect(wrong).toEqual([]);
    }, 120_000);
  },
);
