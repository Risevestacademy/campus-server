import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { auditLog } from '../audit/schema.js';
import {
  CohortRole,
  cohortMembers,
  cohortTracks,
  cohorts,
} from '../cohorts/schema.js';
import { tracks } from '../tracks/schema.js';
import { SystemRole, users } from '../users/schema.js';
import { InviteEmailStatus } from './dto/invite-response.dto.js';
import { InviteImportService } from './invite-import.service.js';
import type { InviteMailer } from './invite-mailer.js';
import {
  InviteInternalException,
  InviteInvalidArgumentException,
  InviteNotFoundException,
} from './invites.exceptions.js';
import { InvitesService } from './invites.service.js';
import { InviteStatus, invites } from './schema.js';

/**
 * Against a real engine, with the real InvitesService underneath: the point
 * of the import is that a row is held to every rule a single invite is, and
 * a mocked create would only prove it was called.
 */
const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);
const db = drizzle(new PGlite(), {
  schema: {
    users,
    tracks,
    cohorts,
    cohortTracks,
    cohortMembers,
    invites,
    auditLog,
  },
});
const config = {
  APP_PUBLIC_URL: 'http://localhost:3000',
  INVITE_TTL_DAYS: 7,
} as never;

const invitesService = new InvitesService(db as never, config);
const mailer = { send: vi.fn() };
const service = new InviteImportService(
  db as never,
  invitesService,
  mailer as unknown as InviteMailer,
);

let inviter: AuthenticatedUser;
let cohortId: string;

const upload = (text: string) =>
  service.import(cohortId, Buffer.from(text, 'utf8'), inviter, 'corr-import');

const stored = () => db.select().from(invites).orderBy(invites.email);

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(
    sql`truncate audit_log, invites, cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
  );
  mailer.send.mockReset();
  mailer.send.mockResolvedValue(InviteEmailStatus.Sent);

  const [admin] = await db
    .insert(users)
    .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
    .returning();
  inviter = { id: admin.id, email: admin.email, systemRole: admin.systemRole };

  const [se, pd] = await db
    .insert(tracks)
    .values([
      { name: 'Software Engineering', code: 'SE' },
      { name: 'Product Design', code: 'PD' },
    ])
    .returning();
  const [c1, c2] = await db
    .insert(cohorts)
    .values([
      { name: 'Cohort 1', code: 'C1' },
      { name: 'Cohort 2', code: 'C2' },
    ])
    .returning();
  // Cohort 1 runs SE only; PD is run by cohort 2.
  await db.insert(cohortTracks).values([
    { cohortId: c1.id, trackId: se.id },
    { cohortId: c2.id, trackId: pd.id },
  ]);
  cohortId = c1.id;
});

describe('InviteImportService', () => {
  it('invites every row, each as an ordinary invite to the cohort', async () => {
    const result = await upload(
      'email,role,track\nada@campus.local,student,se\ngrace@campus.local,professor,\n',
    );

    expect(result).toMatchObject({ total: 2, invited: 2, failed: 0 });
    expect(result.rows).toEqual([
      {
        line: 2,
        email: 'ada@campus.local',
        outcome: 'invited',
        inviteId: expect.any(String),
        inviteLink: expect.stringContaining('/invitation?token='),
        emailStatus: InviteEmailStatus.Sent,
      },
      expect.objectContaining({ line: 3, email: 'grace@campus.local' }),
    ]);

    const rows = await stored();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      email: 'ada@campus.local',
      cohortId,
      cohortRole: CohortRole.Student,
      status: InviteStatus.Pending,
      invitedBy: inviter.id,
    });
    expect(rows[0].cohortTrackId).not.toBeNull();
    expect(rows[1]).toMatchObject({
      cohortRole: CohortRole.Professor,
      cohortTrackId: null,
    });
  });

  it('emails each invite once, and writes an audit entry for each', async () => {
    await upload(
      'email,role\na@campus.local,mentor\nb@campus.local,mentor\nc@campus.local,mentor\n',
    );

    expect(mailer.send).toHaveBeenCalledTimes(3);
    const entries = await db.select().from(auditLog);
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.correlationId === 'corr-import')).toBe(true);
  });

  it('reports the email that could not be sent, and still gives the link', async () => {
    mailer.send.mockResolvedValue(InviteEmailStatus.Failed);

    const result = await upload('email,role\na@campus.local,mentor\n');

    expect(result.rows[0]).toMatchObject({
      outcome: 'invited',
      emailStatus: InviteEmailStatus.Failed,
      inviteLink: expect.any(String),
    });
  });

  it('carries on past a row that fails, and says why against its line', async () => {
    const result = await upload(
      [
        'email,role,track',
        'ada@campus.local,student,SE',
        'not-an-address,student,SE',
        'nosuch@campus.local,student,XX',
        'notrack@campus.local,student,',
        'grace@campus.local,mentor,',
      ].join('\n'),
    );

    expect(result).toMatchObject({ total: 5, invited: 2, failed: 3 });
    expect(
      result.rows.map(({ line, outcome, reason }) => ({
        line,
        outcome,
        reason,
      })),
    ).toEqual([
      { line: 2, outcome: 'invited', reason: undefined },
      { line: 3, outcome: 'failed', reason: 'email is not a valid address' },
      {
        line: 4,
        outcome: 'failed',
        reason: 'This cohort does not run a track with code XX',
      },
      { line: 5, outcome: 'failed', reason: 'track is required for a student' },
      { line: 6, outcome: 'invited', reason: undefined },
    ]);
    expect(await stored()).toHaveLength(2);
    // Nobody is emailed for a row that was not invited.
    expect(mailer.send).toHaveBeenCalledTimes(2);
  });

  // A track is the cohort's to run. The code exists in the catalogue, but
  // this cohort does not run it, so there is no cohortTrackId to put on the
  // invite.
  it('refuses a track the catalogue has but this cohort does not run', async () => {
    const result = await upload(
      'email,role,track\nada@campus.local,student,PD\n',
    );

    expect(result.rows[0]).toMatchObject({
      outcome: 'failed',
      reason: 'This cohort does not run a track with code PD',
    });
  });

  it('invites the first of two rows for one address, and refuses the second', async () => {
    const result = await upload(
      'email,role\nada@campus.local,mentor\nAda@Campus.Local,professor\n',
    );

    expect(result.rows.map((row) => row.outcome)).toEqual([
      'invited',
      'failed',
    ]);
    expect(result.rows[1].reason).toContain('pending invite already exists');
    expect(await stored()).toHaveLength(1);
  });

  // What makes fixing one row and uploading the file again safe.
  it('refuses, the second time, the rows it invited the first time', async () => {
    const file =
      'email,role\nada@campus.local,mentor\ngrace@campus.local,mentor\n';
    await upload(file);
    mailer.send.mockClear();

    const again = await upload(file);

    expect(again).toMatchObject({ invited: 0, failed: 2 });
    expect(await stored()).toHaveLength(2);
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('refuses somebody who is already in the cohort', async () => {
    const [member] = await db
      .insert(users)
      .values({ email: 'member@campus.local' })
      .returning();
    await db
      .insert(cohortMembers)
      .values({ cohortId, userId: member.id, role: CohortRole.Mentor });

    const result = await upload('email,role\nmember@campus.local,professor\n');

    expect(result.rows[0]).toMatchObject({
      outcome: 'failed',
      reason: 'member@campus.local is already a member of this cohort',
    });
  });

  describe('guests', () => {
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();

    it('invites a guest with the visit end the row gives', async () => {
      const result = await upload(
        `email,role,visit_ends\nguest@campus.local,guest,${future}\n`,
      );

      expect(result.rows[0].outcome).toBe('invited');
      const [row] = await stored();
      expect(row.guestAccessExpiresAt?.toISOString()).toBe(future);
    });

    it.each([
      ['no visit end', 'guest', '', 'visit_ends is required for a guest'],
      [
        'a visit end that is not a date',
        'guest',
        'next week',
        'visit_ends is not a date: use a form like 2026-11-30T17:00:00Z',
      ],
      // What the single-invite route refuses, a file must not let through.
      [
        'a visit end written the American way',
        'guest',
        '12/31/2030',
        'visit_ends is not a date: use a form like 2026-11-30T17:00:00Z',
      ],
      [
        'a visit that has already ended',
        'guest',
        '2020-01-01T00:00:00Z',
        'visit_ends must be in the future',
      ],
      [
        'a visit end on somebody who is not a guest',
        'mentor',
        future,
        'visit_ends is only for a guest',
      ],
    ])(
      'refuses %s, in the file’s own words',
      async (_label, role, ends, reason) => {
        const result = await upload(
          `email,role,visit_ends\nperson@campus.local,${role},${ends}\n`,
        );

        expect(result.rows[0]).toMatchObject({ outcome: 'failed', reason });
        expect(await stored()).toHaveLength(0);
      },
    );
  });

  it('answers in the order of the file, whichever rows failed', async () => {
    const result = await upload(
      'email,role\nbad,mentor\nb@campus.local,mentor\nworse,mentor\nd@campus.local,mentor\n',
    );

    expect(result.rows.map((row) => row.line)).toEqual([2, 3, 4, 5]);
  });

  it('invites nobody from a file it cannot read', async () => {
    await expect(upload('role,track\nstudent,SE\n')).rejects.toBeInstanceOf(
      InviteInvalidArgumentException,
    );
    expect(await stored()).toHaveLength(0);
  });

  // The rows that are fine are not invited either: a file whose quoting is
  // broken cannot be trusted to mean what it appears to.
  it('invites nobody from a file with a broken quote', async () => {
    await expect(
      upload(
        'email,role\nada@campus.local,mentor\n"grace@campus.local"x,mentor\n',
      ),
    ).rejects.toBeInstanceOf(InviteInvalidArgumentException);
    expect(await stored()).toHaveLength(0);
  });

  it('404s a cohort that does not exist, and invites nobody', async () => {
    await expect(
      service.import(
        '99999999-9999-4999-8999-999999999999',
        Buffer.from('email,role\nada@campus.local,mentor\n'),
        inviter,
      ),
    ).rejects.toBeInstanceOf(InviteNotFoundException);
    expect(await stored()).toHaveLength(0);
  });

  // A refusal is a row's answer; a fault is not. Reporting one as a failed
  // row would dress a broken import up as a partial one.
  it('stops on a fault rather than filing it under failed rows', async () => {
    const broken = new InviteImportService(
      db as never,
      {
        create: vi
          .fn()
          .mockRejectedValue(new InviteInternalException('invariant broken')),
      } as never,
      mailer as unknown as InviteMailer,
    );

    await expect(
      broken.import(
        cohortId,
        Buffer.from('email,role\nada@campus.local,mentor\n'),
        inviter,
      ),
    ).rejects.toBeInstanceOf(InviteInternalException);
  });

  // The links of the rows before it were never shown and their emails never
  // sent, so left in place they could only be refused as duplicates next
  // time. The whole file is undone and can be uploaded again.
  it('invites nobody when a fault strikes partway through the file', async () => {
    const create = invitesService.create.bind(invitesService);
    let calls = 0;
    const breaksOnThird = new InviteImportService(
      db as never,
      {
        create: (...args: Parameters<typeof create>) => {
          calls += 1;
          if (calls === 3) throw new Error('connection lost');
          return create(...args);
        },
      } as never,
      mailer as unknown as InviteMailer,
    );
    const file = Buffer.from(
      'email,role\nada@campus.local,mentor\ngrace@campus.local,mentor\nlin@campus.local,mentor\n',
    );

    await expect(breaksOnThird.import(cohortId, file, inviter)).rejects.toThrow(
      'connection lost',
    );

    expect(await stored()).toHaveLength(0);
    expect(await db.select().from(auditLog)).toHaveLength(0);
    expect(mailer.send).not.toHaveBeenCalled();

    // And the same file goes through whole once the fault has passed.
    const retry = await upload(file.toString('utf8'));
    expect(retry).toMatchObject({ total: 3, invited: 3, failed: 0 });
  });
});
