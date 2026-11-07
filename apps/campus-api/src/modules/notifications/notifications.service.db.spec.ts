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
import {
  mentorshipGroupStudents,
  mentorshipGroups,
} from '../mentorship-groups/schema.js';
import { NoticeScope } from '../notices/schema.js';
import { tracks } from '../tracks/schema.js';
import { SystemRole, UserStatus, users } from '../users/schema.js';
import { NotificationNotFoundException } from './notifications.exceptions.js';
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

const person = async (
  email: string,
  overrides: Partial<typeof users.$inferInsert> = {},
) => {
  const [row] = await db
    .insert(users)
    .values({ email, ...overrides })
    .returning();
  return row.id;
};

/** Resolves to the membership's id. */
const join = async (
  userId: string,
  cohortId: string,
  role: CohortRole,
  overrides: Partial<typeof cohortMembers.$inferInsert> = {},
) => {
  const [row] = await db
    .insert(cohortMembers)
    .values({
      userId,
      cohortId,
      role,
      ...(role === CohortRole.Student ? { status: StudentStatus.Active } : {}),
      ...overrides,
    })
    .returning();
  return row.id;
};

/** A pod in `cohortId` led by the mentor membership `mentorMemberId`. */
const pod = async (
  cohortId: string,
  mentorMemberId: string,
  studentMemberIds: string[],
) => {
  const [group] = await db
    .insert(mentorshipGroups)
    .values({ cohortId, mentorMemberId, name: `Pod ${randomUUID()}` })
    .returning();
  if (studentMemberIds.length > 0) {
    await db.insert(mentorshipGroupStudents).values(
      studentMemberIds.map((cohortMemberId) => ({
        mentorshipGroupId: group.id,
        cohortId,
        cohortMemberId,
      })),
    );
  }
  return group.id;
};

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
  mentorshipGroupId: string | null = null,
) => ({ id: randomUUID(), scope, cohortId, cohortTrackId, mentorshipGroupId });

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
    cohortId: c1,
    kind: NotificationKind.EntryRequestAdmitted,
    reference: { type: NotificationReferenceType.EntryRequest, id },
    context: { cohortId: c1, spaceKey: 'library' },
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

  it('answers what it wrote, for the push, with the cohort it happened in', async () => {
    const ada = await person('ada@campus.local');
    const input = entryRequest(ada);

    const created = await service.notify(input);

    const [row] = await db.select().from(notifications);
    expect(created).toEqual([
      {
        recipientId: ada,
        cohortId: c1,
        id: row.id,
        kind: 'entry_request_admitted',
        referenceType: 'entry_request',
        referenceId: input.reference.id,
        context: { cohortId: c1, spaceKey: 'library' },
        createdAt: row.createdAt.toISOString(),
      },
    ]);
    // A repeat writes nothing, so pushes nothing.
    await expect(service.notify(input)).resolves.toEqual([]);
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
      readAt: null,
    });
  });

  it('answers each row it wrote, naming no cohort for a campus notice', async () => {
    const ada = await person('ada@campus.local');
    const bob = await person('bob@campus.local');
    await join(ada, c1, CohortRole.Student, { cohortTrackId: c1se });
    await join(ada, c2, CohortRole.Mentor);
    await join(bob, c2, CohortRole.Student, { cohortTrackId: c2se });
    const posted = notice(NoticeScope.Campus);

    const created = await service.notifyNoticePosted(posted);

    const rows = await db.select().from(notifications);
    expect(created).toHaveLength(2);
    expect(created).toEqual(
      expect.arrayContaining(
        rows.map((row) => ({
          recipientId: row.recipientId,
          cohortId: null,
          id: row.id,
          kind: 'notice_posted',
          referenceType: 'notice',
          referenceId: posted.id,
          context: null,
          createdAt: row.createdAt.toISOString(),
        })),
      ),
    );
  });

  it("names the notice's cohort for a cohort-track notice", async () => {
    const ada = await person('ada@campus.local');
    await join(ada, c1, CohortRole.Student, { cohortTrackId: c1se });

    const created = await service.notifyNoticePosted(
      notice(NoticeScope.CohortTrack, c1, c1se),
    );

    expect(created.map((message) => message.cohortId)).toEqual([c1]);
  });

  it('answers only the rows it wrote when some were there already', async () => {
    const ada = await person('ada@campus.local');
    const bob = await person('bob@campus.local');
    await join(ada, c1, CohortRole.Student, { cohortTrackId: c1se });
    await join(bob, c1, CohortRole.Student, { cohortTrackId: c1pd });
    const posted = notice(NoticeScope.Cohort, c1);
    await service.notify({
      recipientId: ada,
      cohortId: c1,
      kind: NotificationKind.NoticePosted,
      reference: { type: NotificationReferenceType.Notice, id: posted.id },
    });

    const created = await service.notifyNoticePosted(posted);

    expect(created.map((message) => message.recipientId)).toEqual([bob]);
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

  it("reaches a cohort-track notice's students and staff, within the cohort", async () => {
    const se1 = await person('se1@campus.local');
    const pd1 = await person('pd1@campus.local');
    const se2 = await person('se2@campus.local');
    const namedProf = await person('named-prof@campus.local');
    const otherProf = await person('other-prof@campus.local');
    const seMentor = await person('se-mentor@campus.local');
    const pdMentor = await person('pd-mentor@campus.local');
    const podless = await person('podless@campus.local');
    const se1Member = await join(se1, c1, CohortRole.Student, {
      cohortTrackId: c1se,
    });
    const pd1Member = await join(pd1, c1, CohortRole.Student, {
      cohortTrackId: c1pd,
    });
    await join(se2, c2, CohortRole.Student, { cohortTrackId: c2se });
    await join(namedProf, c1, CohortRole.Professor, { cohortTrackId: c1se });
    await join(otherProf, c1, CohortRole.Professor);
    await pod(c1, await join(seMentor, c1, CohortRole.Mentor), [se1Member]);
    await pod(c1, await join(pdMentor, c1, CohortRole.Mentor), [pd1Member]);
    await join(podless, c1, CohortRole.Mentor);
    const posted = notice(NoticeScope.CohortTrack, c1, c1se);

    await service.notifyNoticePosted(posted);

    expect(await recipientsOf(posted.id)).toEqual([
      'named-prof@campus.local',
      'se-mentor@campus.local',
      'se1@campus.local',
    ]);
  });

  it("leaves out a track's mentor whose pod holds no live student of it", async () => {
    const mentor = await person('mentor@campus.local');
    const unclassified = await person('unclassified@campus.local');
    await pod(c1, await join(mentor, c1, CohortRole.Mentor), [
      await join(unclassified, c1, CohortRole.Student, {
        cohortTrackId: c1se,
        status: null,
      }),
    ]);
    const posted = notice(NoticeScope.CohortTrack, c1, c1se);

    await service.notifyNoticePosted(posted);

    expect(await recipientsOf(posted.id)).toEqual([]);
  });

  it("reaches a mentorship-group notice's mentor and students only", async () => {
    const mentor = await person('mentor@campus.local');
    const inPod = await person('in-pod@campus.local');
    const leftPod = await person('left-pod@campus.local');
    const otherPod = await person('other-pod@campus.local');
    const group = await pod(c1, await join(mentor, c1, CohortRole.Mentor), [
      await join(inPod, c1, CohortRole.Student, { cohortTrackId: c1se }),
      await join(leftPod, c1, CohortRole.Student, {
        cohortTrackId: c1se,
        leftAt: new Date(),
      }),
    ]);
    const otherMentor = await person('other-mentor@campus.local');
    await pod(c1, await join(otherMentor, c1, CohortRole.Mentor), [
      await join(otherPod, c1, CohortRole.Student, { cohortTrackId: c1se }),
    ]);
    const posted = notice(NoticeScope.MentorshipGroup, c1, null, group);

    await service.notifyNoticePosted(posted);

    expect(await recipientsOf(posted.id)).toEqual([
      'in-pod@campus.local',
      'mentor@campus.local',
    ]);
  });

  it('reaches admins with no cohort for a campus notice, and nobody else without one', async () => {
    await person('admin@campus.local', { systemRole: SystemRole.Admin });
    await person('super@campus.local', { systemRole: SystemRole.SuperAdmin });
    await person('nobody@campus.local');
    const posted = notice(NoticeScope.Campus);

    await service.notifyNoticePosted(posted);

    expect(await recipientsOf(posted.id)).toEqual([
      'admin@campus.local',
      'super@campus.local',
    ]);
  });

  it('leaves out suspended accounts, members and admins alike', async () => {
    const member = await person('member@campus.local', {
      status: UserStatus.Suspended,
    });
    await join(member, c1, CohortRole.Mentor);
    await person('admin@campus.local', {
      systemRole: SystemRole.Admin,
      status: UserStatus.Suspended,
    });
    const posted = notice(NoticeScope.Campus);

    await service.notifyNoticePosted(posted);

    expect(await recipientsOf(posted.id)).toEqual([]);
  });

  it('skips members already notified and still notifies the rest', async () => {
    const ada = await person('ada@campus.local');
    const bob = await person('bob@campus.local');
    await join(ada, c1, CohortRole.Student, { cohortTrackId: c1se });
    await join(bob, c1, CohortRole.Student, { cohortTrackId: c1pd });
    const posted = notice(NoticeScope.Cohort, c1);
    await service.notify({
      recipientId: ada,
      cohortId: c1,
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

describe('reading and marking', () => {
  const page = (overrides: { unread?: boolean; page?: number } = {}) => ({
    page: 1,
    perPage: 2,
    ...overrides,
  });

  /** One for `recipientId`, written `minutesAgo` minutes ago. */
  const alert = async (recipientId: string, minutesAgo: number) => {
    const [row] = await db
      .insert(notifications)
      .values({
        recipientId,
        kind: NotificationKind.NoticePosted,
        referenceType: NotificationReferenceType.Notice,
        referenceId: randomUUID(),
        createdAt: new Date(Date.now() - minutesAgo * 60_000),
      })
      .returning();
    return row;
  };

  it('lists only the recipient’s own, newest first, in pages, without the thing referenced', async () => {
    const ada = await person('ada@campus.local');
    const bob = await person('bob@campus.local');
    const oldest = await alert(ada, 3);
    const middle = await alert(ada, 2);
    const newest = await alert(ada, 1);
    await alert(bob, 0);

    const first = await service.list(ada, page());
    const second = await service.list(ada, page({ page: 2 }));

    expect(first.items).toEqual([
      {
        id: newest.id,
        kind: 'notice_posted',
        referenceType: 'notice',
        referenceId: newest.referenceId,
        context: null,
        read: false,
        createdAt: newest.createdAt,
      },
      expect.objectContaining({ id: middle.id }),
    ]);
    expect(first.meta).toEqual({
      page: 1,
      perPage: 2,
      total: 3,
      totalPages: 2,
    });
    expect(second.items.map((item) => item.id)).toEqual([oldest.id]);
  });

  it('leaves out the read ones when asked for unread', async () => {
    const ada = await person('ada@campus.local');
    const read = await alert(ada, 2);
    const unread = await alert(ada, 1);
    await service.markRead(ada, read.id);

    const listed = await service.list(ada, page({ unread: true }));

    expect(listed.items.map((item) => item.id)).toEqual([unread.id]);
    expect(listed.meta.total).toBe(1);
  });

  it('marks one read, and a second time keeps when it was first read', async () => {
    const ada = await person('ada@campus.local');
    const row = await alert(ada, 1);
    const first = new Date('2026-11-05T10:00:00.000Z');

    await expect(service.markRead(ada, row.id, first)).resolves.toMatchObject({
      id: row.id,
      read: true,
    });
    await expect(
      service.markRead(ada, row.id, new Date('2026-11-05T11:00:00.000Z')),
    ).resolves.toMatchObject({ id: row.id, read: true });

    const [stored] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.id, row.id));
    expect(stored.readAt).toEqual(first);
  });

  it("answers somebody else's as not found, and leaves it unread", async () => {
    const ada = await person('ada@campus.local');
    const bob = await person('bob@campus.local');
    const row = await alert(ada, 1);

    await expect(service.markRead(bob, row.id)).rejects.toBeInstanceOf(
      NotificationNotFoundException,
    );
    await expect(service.markRead(bob, randomUUID())).rejects.toBeInstanceOf(
      NotificationNotFoundException,
    );
    const [stored] = await db.select().from(notifications);
    expect(stored.readAt).toBeNull();
  });

  it("marks all of the recipient's unread read, counting only those", async () => {
    const ada = await person('ada@campus.local');
    const bob = await person('bob@campus.local');
    const already = await alert(ada, 3);
    await service.markRead(ada, already.id);
    await alert(ada, 2);
    await alert(ada, 1);
    await alert(bob, 1);

    await expect(service.markAllRead(ada)).resolves.toEqual({ marked: 2 });
    await expect(service.markAllRead(ada)).resolves.toEqual({ marked: 0 });

    expect((await service.list(ada, page({ unread: true }))).items).toEqual([]);
    expect((await service.list(bob, page({ unread: true }))).meta.total).toBe(
      1,
    );
  });
});
