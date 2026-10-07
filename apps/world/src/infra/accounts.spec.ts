import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  ACCOUNT_QUERY,
  LIVE_MEMBERSHIP_QUERY,
  LIVE_SESSIONS_QUERY,
  looksLikeId,
} from './accounts.js';

/**
 * The users table belongs to campus-api, which owns the migrations. This runs
 * world's actual statement against them, so a column rename over there fails
 * here rather than in production, where it would look like every socket
 * refusing a valid session.
 */
const MIGRATIONS = fileURLToPath(
  new URL('../../../campus-api/src/infra/database/migrations', import.meta.url),
);

const db = new PGlite();

async function accountRow(userId: string) {
  const result = await db.query<{
    id: string;
    status: string;
    system_role: string;
    session_epoch: number;
  }>(ACCOUNT_QUERY, [userId]);
  return result.rows[0];
}

beforeAll(async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const statements = readFileSync(`${MIGRATIONS}/${file}`, 'utf8')
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) {
      await db.exec(statement);
    }
  }
});

describe("world's account lookup, against campus-api's schema", () => {
  it('reads an active account', async () => {
    await db.exec(
      `insert into users (id, email, status) values
        ('11111111-1111-4111-8111-111111111111', 'ada@campus.local', 'active')`,
    );

    const row = await accountRow('11111111-1111-4111-8111-111111111111');

    expect(row).toMatchObject({ status: 'active', system_role: 'user' });
  });

  /** The role decides whether the cohort gate applies, so it has to come back. */
  it('reads the system role, which is what lets an admin past the gate', async () => {
    await db.exec(
      `insert into users (id, email, status, system_role) values
        ('55555555-5555-4555-8555-555555555555', 'admin@campus.local', 'active', 'admin')`,
    );

    expect(
      await accountRow('55555555-5555-4555-8555-555555555555'),
    ).toMatchObject({ system_role: 'admin' });
  });

  it('reads a suspended one, which is what a ban looks like', async () => {
    await db.exec(
      `insert into users (id, email, status) values
        ('22222222-2222-4222-8222-222222222222', 'banned@campus.local', 'suspended')`,
    );

    expect(
      await accountRow('22222222-2222-4222-8222-222222222222'),
    ).toMatchObject({
      status: 'suspended',
    });
  });

  // The number world compares a token's epoch against. Read as a number,
  // not a string: the comparison is strict.
  it('reads the session epoch, starting at zero and following a bump', async () => {
    const id = '66666666-6666-4666-8666-666666666666';
    await db.exec(
      `insert into users (id, email) values ('${id}', 'epoch@campus.local')`,
    );
    expect((await accountRow(id))?.session_epoch).toBe(0);

    await db.exec(
      `update users set session_epoch = session_epoch + 1 where id = '${id}'`,
    );

    expect((await accountRow(id))?.session_epoch).toBe(1);
  });

  it('returns nothing for an id that is not there', async () => {
    expect(
      await accountRow('33333333-3333-4333-8333-333333333333'),
    ).toBeUndefined();
  });
});

describe("world's live-session check, against campus-api's schema", () => {
  const NOW = new Date('2026-09-30T12:00:00.000Z');
  const WINDOW_START = new Date(NOW.getTime() - 20 * 60_000);
  const USER = '44444444-4444-4444-8444-444444444444';

  const LIVE = 'aaaaaaaa-0000-4000-8000-000000000001';
  const SIGNED_OUT = 'aaaaaaaa-0000-4000-8000-000000000002';
  const EXPIRED = 'aaaaaaaa-0000-4000-8000-000000000003';
  const STALE = 'aaaaaaaa-0000-4000-8000-000000000004';
  const ROTATED = 'aaaaaaaa-0000-4000-8000-000000000005';

  async function token(
    family: string,
    fields: {
      createdAt?: Date;
      expiresAt?: Date;
      usedAt?: Date;
      revokedAt?: Date;
    } = {},
  ) {
    await db.query(
      `insert into refresh_tokens (user_id, family_id, token_hash, expires_at, used_at, revoked_at, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        USER,
        family,
        Math.random().toString(36).padEnd(64, '0').slice(0, 64),
        fields.expiresAt ?? new Date(NOW.getTime() + 30 * 86_400_000),
        fields.usedAt ?? null,
        fields.revokedAt ?? null,
        fields.createdAt ?? new Date(NOW.getTime() - 5 * 60_000),
      ],
    );
  }

  async function live(families: string[]): Promise<string[]> {
    const result = await db.query<{ family_id: string }>(LIVE_SESSIONS_QUERY, [
      families,
      WINDOW_START,
      NOW,
    ]);
    return result.rows.map((row) => row.family_id).sort();
  }

  beforeAll(async () => {
    await db.exec(
      `insert into users (id, email, status) values ('${USER}', 'sessions@campus.local', 'active')`,
    );
    await token(LIVE);
    await token(SIGNED_OUT, { revokedAt: new Date(NOW.getTime() - 60_000) });
    await token(EXPIRED, { expiresAt: new Date(NOW.getTime() - 1_000) });
    // Signed in an hour ago and never refreshed since.
    await token(STALE, { createdAt: new Date(NOW.getTime() - 60 * 60_000) });
    // Rotated: an old used row, and the fresh one that replaced it.
    await token(ROTATED, {
      createdAt: new Date(NOW.getTime() - 60 * 60_000),
      usedAt: new Date(NOW.getTime() - 2 * 60_000),
    });
    await token(ROTATED, { createdAt: new Date(NOW.getTime() - 2 * 60_000) });
  });

  it('counts a login refreshed recently as live', async () => {
    expect(await live([LIVE])).toEqual([LIVE]);
  });

  /** Signing out revokes the family: the socket must go with it. */
  it('does not count one that was signed out', async () => {
    expect(await live([SIGNED_OUT])).toEqual([]);
  });

  it('does not count one whose refresh token has expired', async () => {
    expect(await live([EXPIRED])).toEqual([]);
  });

  /**
   * Access taken away shows up as refreshes failing, not as a revocation; a
   * login nobody has refreshed within the window is no longer vouched for.
   */
  it('does not count one that has stopped being refreshed', async () => {
    expect(await live([STALE])).toEqual([]);
  });

  it('counts a rotated login by its newest token', async () => {
    expect(await live([ROTATED])).toEqual([ROTATED]);
  });

  it('answers for many at once, and ignores families it has never heard of', async () => {
    expect(
      await live([
        LIVE,
        SIGNED_OUT,
        EXPIRED,
        STALE,
        ROTATED,
        'bbbbbbbb-0000-4000-8000-000000000009',
      ]),
    ).toEqual([LIVE, ROTATED].sort());
  });
});

/**
 * One test per clause of campus-api's `isLiveMembership`. When the two
 * disagree the gap is a lockout or a leak.
 */
describe("world's cohort gate, against campus-api's schema", () => {
  const NOW = new Date('2026-10-04T12:00:00.000Z');

  const COHORT = 'ccccccc1-0000-4000-8000-000000000001';
  const OTHER_COHORT = 'ccccccc1-0000-4000-8000-000000000002';
  const TRACK = 'ccccccc2-0000-4000-8000-000000000001';
  const COHORT_TRACK = 'ccccccc3-0000-4000-8000-000000000001';
  const OTHER_COHORT_TRACK = 'ccccccc3-0000-4000-8000-000000000002';

  const STUDENT = 'dddddddd-0000-4000-8000-000000000001';
  const UNCLASSIFIED = 'dddddddd-0000-4000-8000-000000000002';
  const DISMISSED = 'dddddddd-0000-4000-8000-000000000003';
  const PROFESSOR = 'dddddddd-0000-4000-8000-000000000004';
  const DEPARTED = 'dddddddd-0000-4000-8000-000000000005';
  const GUEST = 'dddddddd-0000-4000-8000-000000000006';
  const LAPSED_GUEST = 'dddddddd-0000-4000-8000-000000000007';
  const ELSEWHERE = 'dddddddd-0000-4000-8000-000000000008';

  async function isMember(
    userId: string,
    cohortId: string,
    now: Date = NOW,
  ): Promise<boolean> {
    const result = await db.query(LIVE_MEMBERSHIP_QUERY, [
      userId,
      cohortId,
      now,
    ]);
    return result.rows.length > 0;
  }

  async function member(
    userId: string,
    fields: {
      cohortId?: string;
      role?: string;
      status?: string | null;
      leftAt?: Date | null;
      accessExpiresAt?: Date | null;
      trackId?: string | null;
    } = {},
  ) {
    const role = fields.role ?? 'student';
    await db.query(
      `insert into cohort_members
         (user_id, cohort_id, cohort_track_id, role, status, left_at, access_expires_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId,
        fields.cohortId ?? COHORT,
        fields.trackId === undefined
          ? role === 'student'
            ? COHORT_TRACK
            : null
          : fields.trackId,
        role,
        fields.status === undefined ? null : fields.status,
        fields.leftAt ?? null,
        fields.accessExpiresAt ?? null,
      ],
    );
  }

  beforeAll(async () => {
    const people = [
      STUDENT,
      UNCLASSIFIED,
      DISMISSED,
      PROFESSOR,
      DEPARTED,
      GUEST,
      LAPSED_GUEST,
      ELSEWHERE,
    ];
    for (const id of people) {
      await db.query(
        `insert into users (id, email, status) values ($1, $2, $3)`,
        [id, `${id}@campus.local`, 'active'],
      );
    }
    await db.query(
      `insert into cohorts (id, name, code) values ($1, $2, $3), ($4, $5, $6)`,
      [COHORT, 'Cohort 2', 'C2', OTHER_COHORT, 'Cohort 3', 'C3'],
    );
    await db.query(`insert into tracks (id, name, code) values ($1, $2, $3)`, [
      TRACK,
      'Backend',
      'BACKEND',
    ]);
    await db.query(
      `insert into cohort_tracks (id, cohort_id, track_id)
       values ($1, $2, $3), ($4, $5, $6)`,
      [COHORT_TRACK, COHORT, TRACK, OTHER_COHORT_TRACK, OTHER_COHORT, TRACK],
    );

    await member(STUDENT, { status: 'active' });
    await member(UNCLASSIFIED, { status: null });
    await member(DISMISSED, { status: 'dismissed' });
    await member(PROFESSOR, { role: 'professor' });
    await member(DEPARTED, {
      status: 'active',
      leftAt: new Date(NOW.getTime() - 86_400_000),
    });
    await member(GUEST, {
      role: 'guest',
      accessExpiresAt: new Date(NOW.getTime() + 3_600_000),
    });
    await member(LAPSED_GUEST, {
      role: 'guest',
      accessExpiresAt: new Date(NOW.getTime() - 3_600_000),
    });
    await member(ELSEWHERE, {
      cohortId: OTHER_COHORT,
      trackId: OTHER_COHORT_TRACK,
      status: 'active',
    });
  });

  it('admits a student in good standing', async () => {
    expect(await isMember(STUDENT, COHORT)).toBe(true);
  });

  /** Status is the student half of the table; staff never carry one. */
  it('admits staff on their role alone', async () => {
    expect(await isMember(PROFESSOR, COHORT)).toBe(true);
  });

  /** A row nobody has classified is a half-finished enrolment, not a pass. */
  it('refuses a student with no status yet', async () => {
    expect(await isMember(UNCLASSIFIED, COHORT)).toBe(false);
  });

  it('refuses a dismissed student, whose row outlived their place', async () => {
    expect(await isMember(DISMISSED, COHORT)).toBe(false);
  });

  /** Leaving keeps the row and sets a timestamp; it must not read as access. */
  it('refuses somebody who has left', async () => {
    expect(await isMember(DEPARTED, COHORT)).toBe(false);
  });

  it('admits a guest while their visit lasts', async () => {
    expect(await isMember(GUEST, COHORT)).toBe(true);
  });

  it('refuses a guest once their visit has ended', async () => {
    expect(await isMember(LAPSED_GUEST, COHORT)).toBe(false);
  });

  it('turns a guest away at their deadline, not before', async () => {
    const endsAt = new Date(NOW.getTime() + 3_600_000);
    expect(
      await isMember(GUEST, COHORT, new Date(endsAt.getTime() - 60_000)),
    ).toBe(true);
    expect(
      await isMember(GUEST, COHORT, new Date(endsAt.getTime() + 60_000)),
    ).toBe(false);
  });

  /** The whole reason the socket names a cohort. */
  it('refuses a member of another cohort', async () => {
    expect(await isMember(ELSEWHERE, OTHER_COHORT)).toBe(true);
    expect(await isMember(ELSEWHERE, COHORT)).toBe(false);
  });

  it('refuses an account with no membership at all', async () => {
    expect(await isMember('eeeeeeee-0000-4000-8000-000000000001', COHORT)).toBe(
      false,
    );
  });

  /** Without the guard a non-UUID is an internal error, not a refusal. */
  it('recognises only ids campus-api could have issued', () => {
    expect(looksLikeId(COHORT)).toBe(true);
    expect(looksLikeId('cohort-1')).toBe(false);
    expect(looksLikeId('')).toBe(false);
    expect(looksLikeId("'; drop table cohort_members; --")).toBe(false);
  });
});
