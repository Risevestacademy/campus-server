import { eq } from 'drizzle-orm';

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

    it('leaves no live token when every session is ended during a refresh', async () => {
      const survivors: string[] = [];

      for (let round = 0; round < ROUNDS; round += 1) {
        const { user, session } = await signedIn();

        await Promise.allSettled([
          issuer.refreshSession(session.refreshToken),
          after(stagger(round), () => issuer.revokeAllSessions(user.id)),
        ]);

        const live = await liveTokens(user.id);
        if (live.length > 0) {
          survivors.push(`round ${round}: ${live.length} live token(s)`);
        }
      }

      expect(survivors).toEqual([]);
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
