import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { ACCOUNT_QUERY, LIVE_SESSIONS_QUERY } from './accounts.js';

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
  const result = await db.query<{ id: string; status: string }>(ACCOUNT_QUERY, [
    userId,
  ]);
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

    expect(row).toMatchObject({ status: 'active' });
  });

  it('reads a suspended one, which is what a ban looks like', async () => {
    await db.exec(
      `insert into users (id, email, status) values
        ('22222222-2222-4222-8222-222222222222', 'banned@campus.local', 'suspended')`,
    );

    expect(await accountRow('22222222-2222-4222-8222-222222222222')).toMatchObject({
      status: 'suspended',
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
    fields: { createdAt?: Date; expiresAt?: Date; usedAt?: Date; revokedAt?: Date } = {},
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
      await live([LIVE, SIGNED_OUT, EXPIRED, STALE, ROTATED, 'bbbbbbbb-0000-4000-8000-000000000009']),
    ).toEqual([LIVE, ROTATED].sort());
  });
});
