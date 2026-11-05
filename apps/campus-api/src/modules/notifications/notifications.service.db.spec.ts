import { PGlite } from '@electric-sql/pglite';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { isUniqueViolation } from '../../infra/database/unique-violation.js';
import {
  CohortRole,
  StudentStatus,
  cohortMembers,
  cohortTracks,
  cohorts,
} from '../cohorts/schema.js';
import { NoticeScope } from '../notices/schema.js';
import { tracks } from '../tracks/schema.js';
import { users } from '../users/schema.js';
import { NotificationsService } from './notifications.service.js';
import {
  NotificationKind,
  NotificationReferenceType,
  notifications,
} from './schema.js';

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
    notifications,
  },
});
const service = new NotificationsService(db as never);

let c1: string;
let c2: string;
let c1se: string;
let c1pd: string;
let c2se: string;

const person = async (email: string) => {
  const [row] = await db.insert(users).values({ email }).returning();
  return row.id;
};

const join = (
  userId: string,
  cohortId: string,
  role: CohortRole,
  overrides: Partial<typeof cohortMembers.$inferInsert> = {},
) =>
  db.insert(cohortMembers).values({
    userId,
    cohortId,
    role,
    ...(role === CohortRole.Student ? { status: StudentStatus.Active } : {}),
    ...overrides,
  });

const recipientsOf = async (referenceId: string) => {
  const rows = await db
    .select({ email: users.email })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.recipientId))
    .where(eq(notifications.referenceId, referenceId))
    .orderBy(asc(users.email));
  return rows.map((row) => row.email);
};

const notice = (
  scope: NoticeScope,
  cohortId: string | null = null,
  cohortTrackId: string | null = null,
) => ({ id: randomUUID(), scope, cohortId, cohortTrackId });

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(
    sql`truncate notifications, cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
  );
  const [se, pd] = await db
    .insert(tracks)
    .values([
      { name: 'Software Engineering', code: 'SE' },
      { name: 'Product Design', code: 'PD' },
    ])
    .returning();
  const [cohort1, cohort2] = await db
    .insert(cohorts)
    .values([
      { name: 'Cohort 1', code: 'C1' },
      { name: 'Cohort 2', code: 'C2' },
    ])
    .returning();
  const [l1, l2, l3] = await db
    .insert(cohortTracks)
    .values([
      { cohortId: cohort1.id, trackId: se.id },
      { cohortId: cohort1.id, trackId: pd.id },
      { cohortId: cohort2.id, trackId: se.id },
    ])
    .returning();
  [c1, c2, c1se, c1pd, c2se] = [cohort1.id, cohort2.id, l1.id, l2.id, l3.id];
});

describe('NotificationsService.notify', () => {
  const entryRequest = (recipientId: string, id = randomUUID()) => ({
    recipientId,
    kind: NotificationKind.EntryRequestAdmitted,
    reference: { type: NotificationReferenceType.EntryRequest, id },
  });

  it('writes one row for the recipient', async () => {
    const ada = await person('ada@campus.local');
    const input = entryRequest(ada);

    await service.notify(input);

    const rows = await db.select().from(notifications);
    expect(rows).toEqual([
      expect.objectContaining({
        recipientId: ada,
        kind: 'entry_request_admitted',
        referenceType: 'entry_request',
        referenceId: input.reference.id,
        readAt: null,
      }),
    ]);
  });

  it('treats an existing notification as success, and leaves the transaction usable', async () => {
    const ada = await person('ada@campus.local');
    const input = entryRequest(ada);
    await service.notify(input);

    await db.transaction(async (tx) => {
      await service.notify(input, tx as never);
      await service.notify(
        { ...input, kind: NotificationKind.EntryRequestDeclined },
        tx as never,
      );
    });

    const rows = await db.select().from(notifications);
    expect(rows.map((row) => row.kind).sort()).toEqual([
      'entry_request_admitted',
      'entry_request_declined',
    ]);
  });

  it('is backed by the unique index, which rejects a duplicate written directly', async () => {
    const ada = await person('ada@campus.local');
    const row = {
      recipientId: ada,
      kind: NotificationKind.NoticePosted,
      referenceType: NotificationReferenceType.Notice,
      referenceId: randomUUID(),
    };
    await db.insert(notifications).values(row);

    const duplicate = await db
      .insert(notifications)
      .values(row)
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(
      isUniqueViolation(
        duplicate,
        'notifications_recipient_kind_reference_unique',
      ),
    ).toBe(true);
  });
});

describe('NotificationsService.notifyNoticePosted', () => {
  it('reaches every live member of every cohort for a campus notice, once each', async () => {
    const ada = await person('ada@campus.local');
    const bob = await person('bob@campus.local');
    const cy = await person('cy@campus.local');
    await join(ada, c1, CohortRole.Student, { cohortTrackId: c1se });
    await join(ada, c2, CohortRole.Mentor);
    await join(bob, c2, CohortRole.Student, { cohortTrackId: c2se });
    await join(cy, c1, CohortRole.Guest, {
      accessExpiresAt: new Date(Date.now() + 86_400_000),
    });
    const posted = notice(NoticeScope.Campus);

    await service.notifyNoticePosted(posted);

    expect(await recipientsOf(posted.id)).toEqual([
      'ada@campus.local',
      'bob@campus.local',
      'cy@campus.local',
    ]);
    const [row] = await db.select().from(notifications).limit(1);
    expect(row).toMatchObject({
      kind: 'notice_posted',
      referenceType: 'notice',
      referenceId: posted.id,
    });
  });

  it('leaves out memberships that are not live', async () => {
    const live = await person('live@campus.local');
    const left = await person('left@campus.local');
    const unclassified = await person('unclassified@campus.local');
    const expired = await person('expired@campus.local');
    await join(live, c1, CohortRole.Student, { cohortTrackId: c1se });
    await join(left, c1, CohortRole.Mentor, { leftAt: new Date() });
    await join(unclassified, c1, CohortRole.Student, {
      cohortTrackId: c1se,
      status: null,
    });
    await join(expired, c1, CohortRole.Guest, {
      accessExpiresAt: new Date(Date.now() - 1_000),
    });
    const posted = notice(NoticeScope.Campus);

    await service.notifyNoticePosted(posted);

    expect(await recipientsOf(posted.id)).toEqual(['live@campus.local']);
  });

  it("reaches only the notice's cohort for a cohort notice", async () => {
    const ada = await person('ada@campus.local');
    const bob = await person('bob@campus.local');
    await join(ada, c1, CohortRole.Student, { cohortTrackId: c1pd });
    await join(bob, c2, CohortRole.Student, { cohortTrackId: c2se });
    const posted = notice(NoticeScope.Cohort, c1);

    await service.notifyNoticePosted(posted);

    expect(await recipientsOf(posted.id)).toEqual(['ada@campus.local']);
  });

  it("reaches only the track's members within the cohort for a cohort-track notice", async () => {
    const se1 = await person('se1@campus.local');
    const pd1 = await person('pd1@campus.local');
    const se2 = await person('se2@campus.local');
    const staff = await person('staff@campus.local');
    await join(se1, c1, CohortRole.Student, { cohortTrackId: c1se });
    await join(pd1, c1, CohortRole.Student, { cohortTrackId: c1pd });
    await join(se2, c2, CohortRole.Student, { cohortTrackId: c2se });
    await join(staff, c1, CohortRole.Mentor);
    const posted = notice(NoticeScope.CohortTrack, c1, c1se);

    await service.notifyNoticePosted(posted);

    expect(await recipientsOf(posted.id)).toEqual(['se1@campus.local']);
  });

  it('skips members already notified and still notifies the rest', async () => {
    const ada = await person('ada@campus.local');
    const bob = await person('bob@campus.local');
    await join(ada, c1, CohortRole.Student, { cohortTrackId: c1se });
    await join(bob, c1, CohortRole.Student, { cohortTrackId: c1pd });
    const posted = notice(NoticeScope.Cohort, c1);
    await service.notify({
      recipientId: ada,
      kind: NotificationKind.NoticePosted,
      reference: { type: NotificationReferenceType.Notice, id: posted.id },
    });

    await db.transaction(async (tx) => {
      await service.notifyNoticePosted(posted, tx as never);
      await service.notifyNoticePosted(posted, tx as never);
    });

    expect(await recipientsOf(posted.id)).toEqual([
      'ada@campus.local',
      'bob@campus.local',
    ]);
  });
});
