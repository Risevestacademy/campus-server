import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = fileURLToPath(new URL('./migrations', import.meta.url));

const files = (): string[] =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();

/**
 * The migrations before `file`, found by its name rather than its place in
 * the folder, so a migration added or renumbered elsewhere cannot point a
 * test at the wrong one. A name that is not there fails at once, saying so.
 */
function before(file: string): string[] {
  const all = files();
  const at = all.indexOf(file);
  if (at === -1) {
    throw new Error(`no migration named ${file} in ${MIGRATIONS}`);
  }
  return all.slice(0, at);
}

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
  const FILE = '0002_guest_cohort_role.sql';
  let pg: PGlite;
  let adminId: string;

  beforeEach(async () => {
    pg = new PGlite();
    for (const f of before(FILE)) {
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

    await apply(pg, FILE);

    // It could never have been honoured — accepting enrolled the holder into
    // nothing — so it is closed, which also frees the address to be invited
    // properly under invites_email_pending_unique.
    expect(await statusOf('stranded@campus.local')).toBe('revoked');
  });

  it('leaves a settled cohort-less invite as the record it is', async () => {
    await legacyInvite('past@campus.local', 'accepted');

    await apply(pg, FILE);

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

    await apply(pg, FILE);

    const res = await pg.query<{ dismissal_reason: string | null }>(
      'select dismissal_reason from cohort_members',
    );
    expect(res.rows[0].dismissal_reason).toBeNull();
  });
});

/**
 * 0013 gives audit_log.space_id a foreign key to the new spaces table. The
 * audit log already holds rows in deployed databases, and it is append-only
 * by trigger, so the constraint has to go on without touching a row.
 */
describe('0013 against an audit log that already has entries', () => {
  const FILE = '0013_maps_spaces.sql';
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
    for (const f of before(FILE)) {
      await apply(pg, f);
    }
    await pg.query(
      "insert into audit_log (action, subject_type) values ('track_created', 'track')",
    );
  });

  it('applies, leaving the entries as they were', async () => {
    await apply(pg, FILE);

    const res = await pg.query<{ action: string; space_id: string | null }>(
      'select action, space_id from audit_log',
    );
    expect(res.rows).toEqual([{ action: 'track_created', space_id: null }]);
  });

  it('from then on refuses an entry about a space that does not exist', async () => {
    await apply(pg, FILE);

    await expect(
      pg.query(
        "insert into audit_log (action, space_id) values ('x', '00000000-0000-4000-8000-000000000000')",
      ),
    ).rejects.toThrow(/audit_log_space_id_spaces_id_fk/);
  });
});

/**
 * The same hazard as 0002, for the rule that a cohort ends on or after the
 * day it starts. Nothing in the database held to that before, so a deployed
 * one may hold a cohort that breaks it.
 */
describe('the cohort date rule against data the old schema permitted', () => {
  const FILE = '0016_cohort_dates_in_order.sql';
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
    for (const f of before(FILE)) {
      await apply(pg, f);
    }
  });

  const datesOf = async (code: string) =>
    (
      await pg.query<{ start: string | null; end: string | null }>(
        `select start_date::text as start, end_date::text as end from cohorts where code = '${code}'`,
      )
    ).rows[0];

  it('opens the end of a cohort saved with its dates backwards, rather than failing to apply', async () => {
    await pg.query(
      "insert into cohorts (name, code, start_date, end_date) values ('Backwards','BACK','2026-03-01','2026-02-01')",
    );

    await apply(pg, FILE);

    expect(await datesOf('BACK')).toEqual({ start: '2026-03-01', end: null });
  });

  it('leaves a cohort whose dates are in order as it was', async () => {
    await pg.query(
      "insert into cohorts (name, code, start_date, end_date) values ('Fine','FINE','2026-02-01','2026-03-01')",
    );

    await apply(pg, FILE);

    expect(await datesOf('FINE')).toEqual({
      start: '2026-02-01',
      end: '2026-03-01',
    });
  });
});

describe('finding a migration by name', () => {
  it('fails clearly for a migration that is not there', () => {
    expect(() => before('0099_never_written.sql')).toThrow(
      /no migration named 0099_never_written\.sql/,
    );
  });
});
