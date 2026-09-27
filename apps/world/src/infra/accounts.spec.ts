import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { ACCOUNT_QUERY } from './accounts.js';

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
