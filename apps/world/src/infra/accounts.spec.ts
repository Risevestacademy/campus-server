import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { seatKey } from '../seat.js';
import { mayEnter } from '@campus/space-access';

import {
  ACCOUNT_QUERY,
  LIVE_MEMBERSHIP_QUERY,
  LIVE_MEMBERSHIPS_QUERY,
  LIVE_SESSIONS_QUERY,
  MEMBERSHIP_ROWS_QUERY,
  SPACES_QUERY,
  SPACE_LISTS_QUERY,
  looksLikeId,
  toWorldSpace,
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
    display_name: string | null;
    sprite_key: string | null;
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

  // What every other client draws for them.
  it('reads the display name and sprite, and nulls when unset', async () => {
    const id = '77777777-7777-4777-8777-777777777777';
    await db.exec(
      `insert into users (id, email) values ('${id}', 'sprite@campus.local')`,
    );
    expect(await accountRow(id)).toMatchObject({
      display_name: null,
      sprite_key: null,
    });

    await db.exec(
      `update users set display_name = 'Ada L.', sprite_key = 'placeholder-2' where id = '${id}'`,
    );

    expect(await accountRow(id)).toMatchObject({
      display_name: 'Ada L.',
      sprite_key: 'placeholder-2',
    });
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

  /** The sweep's question: one query for many seats, answered as seatKey. */
  async function liveSeats(
    seats: [string, string][],
    now: Date = NOW,
  ): Promise<string[]> {
    const result = await db.query<{ user_id: string; cohort_id: string }>(
      LIVE_MEMBERSHIPS_QUERY,
      [
        seats.map(([userId]) => userId),
        seats.map(([, cohortId]) => cohortId),
        now,
      ],
    );
    return result.rows
      .map((row) => seatKey({ userId: row.user_id, cohortId: row.cohort_id }))
      .sort();
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

  /**
   * The heartbeat's sweep asks about every open socket in one query. The
   * same question, asked of many seats at once, must give the same answer
   * as asking of one — or who belongs would depend on how many sockets
   * happened to be open when the sweep ran.
   */
  it('answers for many seats at once exactly as it does one at a time', async () => {
    const seats: [string, string][] = [
      [STUDENT, COHORT],
      [UNCLASSIFIED, COHORT],
      [DISMISSED, COHORT],
      [PROFESSOR, COHORT],
      [DEPARTED, COHORT],
      [GUEST, COHORT],
      [LAPSED_GUEST, COHORT],
      [ELSEWHERE, OTHER_COHORT],
      [ELSEWHERE, COHORT],
      ['eeeeeeee-0000-4000-8000-000000000001', COHORT],
    ];

    const live = await liveSeats(seats);

    for (const [userId, cohortId] of seats) {
      expect(
        live.includes(seatKey({ userId, cohortId })),
        `${userId} in ${cohortId}`,
      ).toBe(await isMember(userId, cohortId));
    }
    expect(live).toEqual(
      [
        seatKey({ userId: STUDENT, cohortId: COHORT }),
        seatKey({ userId: PROFESSOR, cohortId: COHORT }),
        seatKey({ userId: GUEST, cohortId: COHORT }),
        seatKey({ userId: ELSEWHERE, cohortId: OTHER_COHORT }),
      ].sort(),
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

/**
 * What the door reads: the spaces on the map, the entries on their lists, and
 * each seat's membership row. All three tables are campus-api's, so the
 * statements run against its migrations here, and the rows they return are
 * put to the rule itself, so a column read wrong shows as a wrong answer.
 */
describe("world's space doors, against campus-api's schema", () => {
  const NOW = new Date('2026-10-20T12:00:00.000Z');
  const HOUR = 3_600_000;

  const COHORT = 'eeeeeee1-0000-4000-8000-000000000001';
  const TRACK = 'eeeeeee2-0000-4000-8000-000000000001';
  const COHORT_TRACK = 'eeeeeee3-0000-4000-8000-000000000001';
  const STUDENT = 'eeeeeee4-0000-4000-8000-000000000001';
  const GUEST = 'eeeeeee4-0000-4000-8000-000000000002';
  const NAMED = 'eeeeeee4-0000-4000-8000-000000000003';
  const MENTOR = 'eeeeeee4-0000-4000-8000-000000000004';
  const OUTSIDER = 'eeeeeee4-0000-4000-8000-000000000005';

  let spaceIds: Record<string, string>;
  let groupId: string;

  beforeAll(async () => {
    for (const id of [STUDENT, GUEST, NAMED, MENTOR, OUTSIDER]) {
      await db.query(
        `insert into users (id, email, status) values ($1, $2, 'active')`,
        [id, `${id}@campus.local`],
      );
    }
    await db.query(
      `insert into cohorts (id, name, code) values ($1, 'Cohort 9', 'C9')`,
      [COHORT],
    );
    await db.query(
      `insert into tracks (id, name, code) values ($1, 'Design', 'DESIGN9')`,
      [TRACK],
    );
    await db.query(
      `insert into cohort_tracks (id, cohort_id, track_id) values ($1, $2, $3)`,
      [COHORT_TRACK, COHORT, TRACK],
    );
    await db.query(
      `insert into cohort_members (user_id, cohort_id, cohort_track_id, role, status, access_expires_at)
       values ($1, $4, $5, 'student', 'active', null),
              ($2, $4, null, 'guest', null, $6),
              ($3, $4, $5, 'student', 'active', null)`,
      [
        STUDENT,
        GUEST,
        NAMED,
        COHORT,
        COHORT_TRACK,
        new Date(NOW.getTime() + HOUR),
      ],
    );
    await db.query(
      `insert into cohort_members (user_id, cohort_id, cohort_track_id, role, status)
       values ($1, $3, null, 'mentor', null),
              ($2, $3, $4, 'student', 'active')`,
      [MENTOR, OUTSIDER, COHORT, COHORT_TRACK],
    );
    // One pod: its mentor, and one of the students. The other student is in
    // no group, so a group entry must leave them outside.
    const mentorMember = await db.query<{ id: string }>(
      `select id from cohort_members where user_id = $1`,
      [MENTOR],
    );
    const studentMember = await db.query<{ id: string }>(
      `select id from cohort_members where user_id = $1`,
      [STUDENT],
    );
    groupId = (
      await db.query<{ id: string }>(
        `insert into mentorship_groups (cohort_id, mentor_member_id, name)
         values ($1, $2, 'The Ravens') returning id`,
        [COHORT, mentorMember.rows[0].id],
      )
    ).rows[0].id;
    await db.query(
      `insert into mentorship_group_students (mentorship_group_id, cohort_id, cohort_member_id)
       values ($1, $2, $3)`,
      [groupId, COHORT, studentMember.rows[0].id],
    );

    const map = await db.query<{ id: string }>(
      `insert into maps (key, name) values ('doors', 'Doors') returning id`,
    );
    const other = await db.query<{ id: string }>(
      `insert into maps (key, name) values ('elsewhere', 'Elsewhere') returning id`,
    );
    spaceIds = {};
    for (const [key, mapId, kind, access, retired] of [
      ['lounge', map.rows[0].id, 'meeting_room', 'normal', null],
      ['classroom', map.rows[0].id, 'classroom', 'designated', null],
      ['pod', map.rows[0].id, 'mentor_pod', 'designated', null],
      ['garden', map.rows[0].id, 'meeting_room', 'designated', null],
      ['old', map.rows[0].id, 'meeting_room', 'normal', NOW],
      ['annex', other.rows[0].id, 'meeting_room', 'normal', null],
    ] as const) {
      const row = await db.query<{ id: string }>(
        `insert into spaces (map_id, key, name, kind, audio_mode, access, retired_at)
         values ($1, $2, $2, $3, 'boundary', $4, $5) returning id`,
        [mapId, key, kind, access, retired],
      );
      spaceIds[key] = row.rows[0].id;
    }
    await db.query(
      `insert into space_memberships (space_id, cohort_role, valid_from) values ($1, 'student', $2)`,
      [spaceIds.classroom, new Date(NOW.getTime() - HOUR)],
    );
    // One person named on the pod, and one whose entry has already ended.
    await db.query(
      `insert into space_memberships (space_id, user_id, valid_from, valid_to)
       values ($1, $2, $4, null), ($1, $3, $4, $5)`,
      [
        spaceIds.pod,
        NAMED,
        STUDENT,
        new Date(NOW.getTime() - 2 * HOUR),
        new Date(NOW.getTime() - HOUR),
      ],
    );
    // The garden is listed for the pod itself: its students and its mentor.
    await db.query(
      `insert into space_memberships (space_id, mentorship_group_id, valid_from)
       values ($1, $2, $3)`,
      [spaceIds.garden, groupId, new Date(NOW.getTime() - HOUR)],
    );
  });

  async function spaces() {
    const rows = (
      await db.query<{
        id: string;
        key: string;
        kind: string | null;
        access: string;
        retired_at: Date | null;
      }>(SPACES_QUERY, ['doors'])
    ).rows;
    const entries = (
      await db.query<{
        space_id: string;
        user_id: string | null;
        cohort_track_id: string | null;
        cohort_role: string | null;
        system_role: string | null;
        mentorship_group_id: string | null;
        valid_from: Date;
        valid_to: Date | null;
      }>(SPACE_LISTS_QUERY, [rows.map((row) => row.id), NOW])
    ).rows;
    return new Map(
      rows.map((row) => [
        row.key,
        {
          kind: row.kind,
          access: row.access,
          retiredAt: row.retired_at,
          locked: false,
          grants: entries
            .filter((entry) => entry.space_id === row.id)
            .map((entry) => ({
              toUserId: entry.user_id,
              toTrackId: entry.cohort_track_id,
              toCohortRole: entry.cohort_role,
              toSystemRole: entry.system_role,
              toGroupId: entry.mentorship_group_id,
              validFrom: entry.valid_from,
              validTo: entry.valid_to,
            })),
        },
      ]),
    );
  }

  async function person(userId: string) {
    const row = (
      await db.query<{
        cohort_id: string;
        role: string;
        left_at: Date | null;
        status: string | null;
        access_expires_at: Date | null;
        cohort_track_id: string | null;
        mentorship_group_id: string | null;
      }>(MEMBERSHIP_ROWS_QUERY, [[userId], [COHORT]])
    ).rows[0];
    return {
      userId,
      systemRole: 'user',
      cohortId: COHORT,
      membership: {
        cohortId: row.cohort_id,
        role: row.role,
        leftAt: row.left_at,
        status: row.status,
        accessExpiresAt: row.access_expires_at,
        trackId: row.cohort_track_id,
        mentorshipGroupId: row.mentorship_group_id,
      },
    };
  }

  it("reads every space on the map, retired ones too, and none on another map's", async () => {
    expect([...(await spaces()).keys()].sort()).toEqual([
      'classroom',
      'garden',
      'lounge',
      'old',
      'pod',
    ]);
  });

  it('leaves out an entry that has ended', async () => {
    const pod = (await spaces()).get('pod');

    expect(pod?.grants.map((grant) => grant.toUserId)).toEqual([NAMED]);
  });

  it('reads a membership row as it stands: role, track, group and visit', async () => {
    expect((await person(GUEST)).membership).toMatchObject({
      role: 'guest',
      trackId: null,
      mentorshipGroupId: null,
      accessExpiresAt: new Date(NOW.getTime() + HOUR),
    });
    expect((await person(STUDENT)).membership).toMatchObject({
      role: 'student',
      status: 'active',
      trackId: COHORT_TRACK,
      mentorshipGroupId: groupId,
    });
    // A mentor holds the pod from the other side, and reads the same group.
    expect((await person(MENTOR)).membership).toMatchObject({
      role: 'mentor',
      mentorshipGroupId: groupId,
    });
    expect((await person(OUTSIDER)).membership).toMatchObject({
      mentorshipGroupId: null,
    });
  });

  it('gives the rule what it needs to answer at each door', async () => {
    const book = await spaces();
    const at = (who: Awaited<ReturnType<typeof person>>, key: string) =>
      mayEnter(who, book.get(key)!, NOW);
    const student = await person(STUDENT);
    const guest = await person(GUEST);
    const named = await person(NAMED);
    const mentor = await person(MENTOR);
    const outsider = await person(OUTSIDER);

    expect(at(student, 'lounge')).toBe(true);
    expect(at(guest, 'lounge')).toBe(true);
    expect(at(student, 'classroom')).toBe(true);
    expect(at(guest, 'classroom')).toBe(false);
    expect(at(named, 'pod')).toBe(true);
    // Their entry ended an hour ago.
    expect(at(student, 'pod')).toBe(false);
    // The garden is listed for their pod: its students and its mentor, and
    // nobody else.
    expect(at(student, 'garden')).toBe(true);
    expect(at(mentor, 'garden')).toBe(true);
    expect(at(outsider, 'garden')).toBe(false);
    expect(at(student, 'old')).toBe(false);
  });
});

/**
 * The row world reads need not come from this build's enum: world and the
 * database deploy separately, so a newer database may know a mode this build
 * does not. It is settled once, here, rather than carried around as a string
 * every comparison downstream reads as "not proximity".
 */
describe('reading a space row', () => {
  const row = {
    id: '11111111-1111-4111-8111-111111111111',
    key: 'library',
    kind: 'meeting_room',
    access: 'normal',
    retired_at: null,
    audio_mode: 'proximity',
    audible_radius: null,
    subscribe_radius: null,
    hysteresis_factor: '1.4',
  };

  it('carries the modes it knows', () => {
    expect(toWorldSpace(row, []).audioMode).toBe('proximity');
    expect(toWorldSpace({ ...row, audio_mode: 'boundary' }, []).audioMode).toBe(
      'boundary',
    );
  });

  it('reads a mode it does not know as boundary, so it hears as one room', () => {
    expect(toWorldSpace({ ...row, audio_mode: 'spatial' }, []).audioMode).toBe(
      'boundary',
    );
  });
});
