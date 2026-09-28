import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = fileURLToPath(new URL('./migrations', import.meta.url));

const files = (): string[] =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();

async function apply(pg: PGlite, file: string): Promise<void> {
  for (const stmt of readFileSync(`${MIGRATIONS}/${file}`, 'utf8').split(
    '--> statement-breakpoint',
  )) {
    if (stmt.trim()) {
      await pg.exec(stmt);
    }
  }
}

/**
 * 0002 adds constraints to tables that already hold rows in deployed
 * databases. A CHECK is validated against every existing row when it is
 * added, so a constraint the old data cannot satisfy aborts the migration
 * and rolls back the deploy — which no schema-level test would catch,
 * because those start from an empty database.
 *
 * These apply the earlier migrations, write the shapes the old code allowed,
 * and only then run 0002.
 */
describe('0002 against data the old schema permitted', () => {
  let pg: PGlite;
  let adminId: string;

  beforeEach(async () => {
    pg = new PGlite();
    for (const f of files().slice(0, 2)) {
      await apply(pg, f);
    }
    const res = await pg.query<{ id: string }>(
      "insert into users (email, system_role) values ('admin@campus.local','admin') returning id",
    );
    adminId = res.rows[0].id;
  });

  const legacyInvite = async (email: string, status: string): Promise<void> => {
    // The shape the removed code supported: no cohort, no cohort role, and
    // an ordinary system role.
    await pg.query(
      `insert into invites (email, token_hash, invited_by, expires_at, system_role, status)
       values ('${email}', '${email}-hash', '${adminId}', now() + interval '1 day', 'user', '${status}')`,
    );
  };

  const statusOf = async (email: string): Promise<string> => {
    const res = await pg.query<{ status: string }>(
      `select status from invites where email = '${email}'`,
    );
    return res.rows[0].status;
  };

  it('closes a pending cohort-less invite rather than failing to apply', async () => {
    await legacyInvite('stranded@campus.local', 'pending');

    await apply(pg, files()[2]);

    // It could never have been honoured — accepting enrolled the holder into
    // nothing — so it is closed, which also frees the address to be invited
    // properly under invites_email_pending_unique.
    expect(await statusOf('stranded@campus.local')).toBe('revoked');
  });

  it('leaves a settled cohort-less invite as the record it is', async () => {
    await legacyInvite('past@campus.local', 'accepted');

    await apply(pg, files()[2]);

    expect(await statusOf('past@campus.local')).toBe('accepted');
  });

  it('clears a dismissal reason left on a row that is not dismissed', async () => {
    const t = await pg.query<{ id: string }>(
      "insert into tracks (name, code) values ('SE','SE') returning id",
    );
    const c = await pg.query<{ id: string }>(
      "insert into cohorts (name, code) values ('C1','C1') returning id",
    );
    const ct = await pg.query<{ id: string }>(
      `insert into cohort_tracks (cohort_id, track_id) values ('${c.rows[0].id}','${t.rows[0].id}') returning id`,
    );
    await pg.query(
      `insert into cohort_members (cohort_id, user_id, cohort_track_id, role, status, dismissal_reason)
       values ('${c.rows[0].id}','${adminId}','${ct.rows[0].id}','student','active','left over')`,
    );

    await apply(pg, files()[2]);

    const res = await pg.query<{ dismissal_reason: string | null }>(
      'select dismissal_reason from cohort_members',
    );
    expect(res.rows[0].dismissal_reason).toBeNull();
  });
});
