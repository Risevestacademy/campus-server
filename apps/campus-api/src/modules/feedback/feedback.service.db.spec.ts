import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { AuditAction, AuditSubjectType, auditLog } from '../audit/schema.js';
import { CohortRole, cohortMembers, cohorts } from '../cohorts/schema.js';
import { SystemRole, UserStatus, users } from '../users/schema.js';
import type { CreateFeedbackDto } from './dto/feedback.dto.js';
import {
  FeedbackInvalidArgumentException,
  FeedbackNotFoundException,
  FeedbackRateLimitedException,
} from './feedback.exceptions.js';
import { FEEDBACK_MAX_PER_HOUR, FeedbackService } from './feedback.service.js';
import { FeedbackStatus, FeedbackType, feedback } from './schema.js';

/**
 * Against a real engine (PGlite, committed migrations applied): the rules
 * are constraints and the list is SQL, and a mocked query builder would only
 * prove they were called.
 */
const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);

const db = drizzle(new PGlite(), {
  schema: { users, cohorts, cohortMembers, feedback, auditLog },
});
const service = new FeedbackService(db as never);

const NOBODY = '00000000-0000-4000-8000-000000000000';

let ada: AuthenticatedUser;
let grace: AuthenticatedUser;
let admin: AuthenticatedUser;
let superAdmin: AuthenticatedUser;
let cohortId: string;

const bug = (
  overrides: Partial<CreateFeedbackDto> = {},
): CreateFeedbackDto => ({
  type: FeedbackType.Bug,
  title: 'The library door will not open',
  details: 'I walk up to it from the courtyard and nothing happens.',
  ...overrides,
});

/** Asserts the write failed on one specific named constraint. */
async function expectViolation(
  write: Promise<unknown>,
  constraint: string,
): Promise<void> {
  let error: unknown;
  try {
    await write;
  } catch (caught) {
    error = caught;
  }
  const detail =
    error instanceof Error
      ? `${error.message} ${(error.cause as Error | undefined)?.message ?? ''}`
      : String(error);
  expect(
    error,
    `expected a violation of ${constraint}, but the write succeeded`,
  ).toBeDefined();
  expect(detail).toContain(constraint);
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(
    sql`truncate audit_log, feedback, cohort_members, cohorts, users cascade`,
  );
  const [a, g, root, suspended] = await db
    .insert(users)
    .values([
      { email: 'ada@campus.local', displayName: 'Ada Lovelace' },
      { email: 'grace@campus.local' },
      { email: 'root@campus.local', systemRole: SystemRole.SuperAdmin },
      {
        email: 'gone@campus.local',
        systemRole: SystemRole.Admin,
        status: UserStatus.Suspended,
      },
    ])
    .returning();
  void suspended;
  const [second] = await db
    .insert(users)
    .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
    .returning();
  const [cohort] = await db
    .insert(cohorts)
    .values({ name: 'Cohort 1', code: 'C1' })
    .returning();
  const as = (row: typeof a): AuthenticatedUser => ({
    id: row.id,
    email: row.email,
    systemRole: row.systemRole,
  });
  [ada, grace, admin, superAdmin] = [as(a), as(g), as(second), as(root)];
  cohortId = cohort.id;
  // Ada is in the cohort; Grace is in none.
  await db
    .insert(cohortMembers)
    .values({ cohortId, userId: ada.id, role: CohortRole.Mentor });
});

describe('sending', () => {
  it('saves what was sent, from whoever the session says sent it', async () => {
    const receipt = await service.create(
      ada,
      bug({
        about: 'The library, by the east door',
        cohortId,
        context: { path: '/campus', mapId: 'campus', x: 75, y: 59 },
      }),
      'Mozilla/5.0 Test',
      new Date('2026-10-12T09:30:00Z'),
    );

    expect(receipt).toEqual({
      id: expect.any(String),
      type: FeedbackType.Bug,
      title: 'The library door will not open',
      createdAt: new Date('2026-10-12T09:30:00Z'),
    });
    await expect(service.get(admin, receipt.id)).resolves.toEqual({
      id: receipt.id,
      type: FeedbackType.Bug,
      title: 'The library door will not open',
      details: 'I walk up to it from the courtyard and nothing happens.',
      about: 'The library, by the east door',
      status: FeedbackStatus.Open,
      submittedBy: {
        id: ada.id,
        email: 'ada@campus.local',
        displayName: 'Ada Lovelace',
      },
      reportedUser: null,
      cohortId,
      context: { path: '/campus', mapId: 'campus', x: 75, y: 59 },
      userAgent: 'Mozilla/5.0 Test',
      resolvedBy: null,
      resolvedAt: null,
      createdAt: new Date('2026-10-12T09:30:00Z'),
    });
  });

  /** Offered on every type, required on none. */
  it.each(Object.values(FeedbackType))(
    'takes a %s with nothing said about who or where',
    async (type) => {
      const { id } = await service.create(ada, bug({ type }), undefined);

      await expect(service.get(admin, id)).resolves.toMatchObject({
        type,
        about: null,
        context: null,
        cohortId: null,
        userAgent: null,
      });
    },
  );

  it('lets a report name the account it is about', async () => {
    const { id } = await service.create(
      ada,
      bug({ type: FeedbackType.Report, reportedUserId: grace.id }),
      undefined,
    );

    await expect(service.get(admin, id)).resolves.toMatchObject({
      reportedUser: {
        id: grace.id,
        email: 'grace@campus.local',
        displayName: null,
      },
    });
  });

  /** An account id is an accusation; a bug or an idea has no business making one. */
  it.each([FeedbackType.Bug, FeedbackType.Idea])(
    'refuses an account named on a %s',
    async (type) => {
      await expect(
        service.create(ada, bug({ type, reportedUserId: grace.id }), undefined),
      ).rejects.toMatchObject({
        constructor: FeedbackInvalidArgumentException,
        details: { fields: { reportedUserId: expect.any(String) } },
      });
    },
  );

  it('refuses an account or a cohort that does not exist, as the caller’s mistake', async () => {
    await expect(
      service.create(
        ada,
        bug({ type: FeedbackType.Report, reportedUserId: NOBODY }),
        undefined,
      ),
    ).rejects.toMatchObject({
      constructor: FeedbackInvalidArgumentException,
      details: { fields: { reportedUserId: expect.any(String) } },
    });
    // An admin is not asked which cohorts they are in, so theirs is the one
    // that reaches the database.
    await expect(
      service.create(admin, bug({ cohortId: NOBODY }), undefined),
    ).rejects.toMatchObject({
      constructor: FeedbackInvalidArgumentException,
      details: { fields: { cohortId: 'cohortId names no cohort' } },
    });
  });

  /** A hint about where they were; one they could not have been in is not one. */
  it('refuses a cohort the sender is not in, and takes any from an admin', async () => {
    await expect(
      service.create(grace, bug({ cohortId }), undefined),
    ).rejects.toMatchObject({
      constructor: FeedbackInvalidArgumentException,
      details: { fields: { cohortId: 'cohortId is not a cohort you are in' } },
    });
    await expect(
      service.create(admin, bug({ cohortId }), undefined),
    ).resolves.toBeDefined();
  });

  it('refuses a cohort the sender has left', async () => {
    await db.update(cohortMembers).set({ leftAt: new Date() });

    await expect(
      service.create(ada, bug({ cohortId }), undefined),
    ).rejects.toBeInstanceOf(FeedbackInvalidArgumentException);
  });

  /**
   * The request check strips what cannot be seen before it asks whether
   * anything is left. Should something blank reach the database anyway, the
   * database's refusal is still the sender's to correct, and not a 500.
   */
  it.each(['title', 'details'] as const)(
    'answers a blank %s the database refused as the caller’s mistake',
    async (field) => {
      await expect(
        service.create(ada, bug({ [field]: ' \t\n ' }), undefined),
      ).rejects.toMatchObject({
        constructor: FeedbackInvalidArgumentException,
        details: { fields: { [field]: expect.any(String) } },
      });
    },
  );

  it('keeps a browser’s name to the length the column holds', async () => {
    const { id } = await service.create(ada, bug(), 'x'.repeat(2_000));

    expect((await service.get(admin, id)).userAgent).toHaveLength(512);
  });

  describe('more than one account may send in an hour', () => {
    const at = (minutes: number) =>
      new Date(Date.parse('2026-10-12T09:00:00Z') + minutes * 60_000);

    it('is refused, whatever the type', async () => {
      for (let i = 0; i < FEEDBACK_MAX_PER_HOUR; i++) {
        await service.create(ada, bug(), undefined, at(i));
      }

      await expect(
        service.create(
          ada,
          bug({ type: FeedbackType.Idea }),
          undefined,
          at(30),
        ),
      ).rejects.toBeInstanceOf(FeedbackRateLimitedException);
      const [{ total }] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(feedback);
      expect(total).toBe(FEEDBACK_MAX_PER_HOUR);
    });

    it('is counted per account, and only over the last hour', async () => {
      for (let i = 0; i < FEEDBACK_MAX_PER_HOUR; i++) {
        await service.create(ada, bug(), undefined, at(i));
      }

      // Somebody else is not held up by it.
      await expect(
        service.create(grace, bug(), undefined, at(30)),
      ).resolves.toBeDefined();
      // And an hour after the first, there is room for one more.
      await expect(
        service.create(ada, bug(), undefined, at(60.5)),
      ).resolves.toBeDefined();
    });
  });
});

describe('the rules in the database', () => {
  const row = (overrides: Partial<typeof feedback.$inferInsert> = {}) =>
    db.insert(feedback).values({
      type: FeedbackType.Bug,
      title: 'Title',
      details: 'Details',
      submittedBy: ada.id,
      ...overrides,
    });

  it('refuses a title or details that say nothing', async () => {
    await expectViolation(row({ title: '   ' }), 'feedback_title_not_blank');
    await expectViolation(
      row({ details: ' \n ' }),
      'feedback_details_not_blank',
    );
  });

  it('refuses details longer than the form allows', async () => {
    await expectViolation(
      row({ details: 'x'.repeat(4_001) }),
      'feedback_details_length',
    );
    await expect(row({ details: 'x'.repeat(4_000) })).resolves.toBeDefined();
  });

  it('refuses an account named on anything but a report', async () => {
    await expectViolation(
      row({ reportedUserId: grace.id }),
      'feedback_reported_user_on_reports',
    );
  });

  /** Resolved by somebody, at some time, or not resolved: never half of it. */
  it('refuses a resolution with a part missing', async () => {
    await expectViolation(
      row({ status: FeedbackStatus.Resolved }),
      'feedback_resolution',
    );
    await expectViolation(
      row({ status: FeedbackStatus.Resolved, resolvedAt: new Date() }),
      'feedback_resolution',
    );
    await expectViolation(
      row({ resolvedAt: new Date(), resolvedBy: admin.id }),
      'feedback_resolution',
    );
    await expect(
      row({
        status: FeedbackStatus.Resolved,
        resolvedAt: new Date(),
        resolvedBy: admin.id,
      }),
    ).resolves.toBeDefined();
  });

  /** It is a hint, and must never be what keeps a cohort from being deleted. */
  it('lets its cohort be deleted, and forgets it', async () => {
    const { id } = await service.create(ada, bug({ cohortId }), undefined);
    await db.delete(cohortMembers);

    await db.delete(cohorts);

    await expect(service.get(admin, id)).resolves.toMatchObject({
      cohortId: null,
    });
  });

  it('is sent by an account that exists', async () => {
    await expectViolation(
      row({ submittedBy: NOBODY }),
      'feedback_submitted_by_users_id_fk',
    );
  });
});

describe('the admin’s list', () => {
  const titles = async (
    filters: Parameters<FeedbackService['list']>[1] = { page: 1, perPage: 20 },
  ) => (await service.list(admin, filters)).items.map((item) => item.title);

  beforeEach(async () => {
    const send = (
      author: AuthenticatedUser,
      title: string,
      type: FeedbackType,
      at: string,
    ) => service.create(author, bug({ title, type }), undefined, new Date(at));

    await send(ada, 'first', FeedbackType.Bug, '2026-10-10T09:00:00Z');
    await send(grace, 'second', FeedbackType.Idea, '2026-10-11T09:00:00Z');
    const third = await send(
      ada,
      'third',
      FeedbackType.Report,
      '2026-10-12T09:00:00Z',
    );
    await service.setStatus(admin, third.id, FeedbackStatus.Resolved);
  });

  it('lists everything newest first, with who sent each and no details', async () => {
    const page = await service.list(admin, { page: 1, perPage: 20 });

    expect(page.items.map((item) => item.title)).toEqual([
      'third',
      'second',
      'first',
    ]);
    expect(page.meta).toEqual({
      page: 1,
      perPage: 20,
      total: 3,
      totalPages: 1,
    });
    expect(page.items[0]).toEqual({
      id: expect.any(String),
      type: FeedbackType.Report,
      title: 'third',
      about: null,
      status: FeedbackStatus.Resolved,
      submittedBy: {
        id: ada.id,
        email: 'ada@campus.local',
        displayName: 'Ada Lovelace',
      },
      reportedUser: null,
      createdAt: new Date('2026-10-12T09:00:00Z'),
    });
  });

  it('filters by type, by status and by who sent it, together', async () => {
    const page = { page: 1, perPage: 20 };

    await expect(titles({ ...page, type: FeedbackType.Idea })).resolves.toEqual(
      ['second'],
    );
    await expect(
      titles({ ...page, status: FeedbackStatus.Open }),
    ).resolves.toEqual(['second', 'first']);
    await expect(titles({ ...page, submittedBy: ada.id })).resolves.toEqual([
      'third',
      'first',
    ]);
    await expect(
      titles({ ...page, submittedBy: ada.id, status: FeedbackStatus.Open }),
    ).resolves.toEqual(['first']);
    await expect(titles({ ...page, submittedBy: NOBODY })).resolves.toEqual([]);
  });

  it('pages without repeating or dropping one, and counts what the filter matched', async () => {
    const first = await service.list(admin, { page: 1, perPage: 2 });
    const second = await service.list(admin, { page: 2, perPage: 2 });

    expect(first.items.map((item) => item.title)).toEqual(['third', 'second']);
    expect(second.items.map((item) => item.title)).toEqual(['first']);
    expect(first.meta).toMatchObject({ total: 3, totalPages: 2 });
    await expect(
      service.list(admin, { page: 1, perPage: 2, type: FeedbackType.Bug }),
    ).resolves.toMatchObject({ meta: { total: 1, totalPages: 1 } });
  });

  /** Sent in the same instant, they must still fall on one page each. */
  it('keeps entries with the same time in one order across pages', async () => {
    await db.execute(sql`truncate feedback cascade`);
    const at = new Date('2026-10-12T09:00:00Z');
    for (const title of ['a', 'b', 'c', 'd']) {
      await service.create(ada, bug({ title }), undefined, at);
    }
    const ids = (
      await db.select({ id: feedback.id, title: feedback.title }).from(feedback)
    ).sort((x, y) => (x.id < y.id ? 1 : -1));

    const pages = await Promise.all(
      [1, 2].map((page) => titles({ page, perPage: 2 })),
    );

    // Newest id first, which is what breaks the tie.
    expect(pages.flat()).toEqual(ids.map((row) => row.title));
  });
});

describe('reading one', () => {
  it('404s an id that names nothing', async () => {
    await expect(service.get(admin, NOBODY)).rejects.toBeInstanceOf(
      FeedbackNotFoundException,
    );
  });
});

describe('resolving and reopening', () => {
  let id: string;

  beforeEach(async () => {
    ({ id } = await service.create(
      ada,
      bug({ type: FeedbackType.Report, details: 'What Grace said to me.' }),
      undefined,
    ));
  });

  const entries = () =>
    db
      .select({
        actorUserId: auditLog.actorUserId,
        action: auditLog.action,
        subjectType: auditLog.subjectType,
        subjectId: auditLog.subjectId,
        details: auditLog.details,
        correlationId: auditLog.correlationId,
      })
      .from(auditLog)
      .orderBy(auditLog.createdAt, auditLog.id);

  it('records who resolved it and when, and says so in the audit log', async () => {
    const at = new Date('2026-10-13T11:00:00Z');

    const resolved = await service.setStatus(
      admin,
      id,
      FeedbackStatus.Resolved,
      'corr-1',
      at,
    );

    expect(resolved).toMatchObject({
      status: FeedbackStatus.Resolved,
      resolvedAt: at,
      resolvedBy: { id: admin.id, email: 'admin@campus.local' },
    });
    await expect(entries()).resolves.toEqual([
      {
        actorUserId: admin.id,
        action: AuditAction.FeedbackResolved,
        subjectType: AuditSubjectType.Feedback,
        subjectId: id,
        // Nothing of what the member wrote: that stays on the feedback.
        details: {},
        correlationId: 'corr-1',
      },
    ]);
  });

  it('puts it back to open, clearing who and when', async () => {
    await service.setStatus(admin, id, FeedbackStatus.Resolved);

    const reopened = await service.setStatus(admin, id, FeedbackStatus.Open);

    expect(reopened).toMatchObject({
      status: FeedbackStatus.Open,
      resolvedAt: null,
      resolvedBy: null,
    });
    expect((await entries()).map((entry) => entry.action)).toEqual([
      AuditAction.FeedbackResolved,
      AuditAction.FeedbackReopened,
    ]);
  });

  it('changes nothing and records nothing when it already has that status', async () => {
    const first = await service.setStatus(
      admin,
      id,
      FeedbackStatus.Resolved,
      undefined,
      new Date('2026-10-13T11:00:00Z'),
    );

    const again = await service.setStatus(
      admin,
      id,
      FeedbackStatus.Resolved,
      undefined,
      new Date('2026-10-14T11:00:00Z'),
    );

    expect(again).toEqual(first);
    await expect(entries()).resolves.toHaveLength(1);
    await service.setStatus(admin, id, FeedbackStatus.Open);
    await service.setStatus(admin, id, FeedbackStatus.Open);
    await expect(entries()).resolves.toHaveLength(2);
  });

  it('404s an id that names nothing, and records nothing', async () => {
    await expect(
      service.setStatus(admin, NOBODY, FeedbackStatus.Resolved),
    ).rejects.toBeInstanceOf(FeedbackNotFoundException);
    await expect(entries()).resolves.toEqual([]);
  });
});

/**
 * Somebody who is reported must not be the one to read who reported them and
 * what was said, or to mark it dealt with. Another admin handles it.
 */
describe('a report that names an admin', () => {
  let id: string;

  beforeEach(async () => {
    ({ id } = await service.create(
      ada,
      bug({ type: FeedbackType.Report, reportedUserId: admin.id }),
      undefined,
    ));
  });

  it('is not in that admin’s list, and is in everybody else’s', async () => {
    const page = { page: 1, perPage: 20 };

    await expect(service.list(admin, page)).resolves.toMatchObject({
      items: [],
      meta: { total: 0 },
    });
    await expect(service.list(superAdmin, page)).resolves.toMatchObject({
      items: [{ id }],
      meta: { total: 1 },
    });
  });

  it('answers that admin as if it were not there', async () => {
    await expect(service.get(admin, id)).rejects.toBeInstanceOf(
      FeedbackNotFoundException,
    );
    await expect(service.get(superAdmin, id)).resolves.toMatchObject({ id });
  });

  it('cannot be resolved by that admin', async () => {
    await expect(
      service.setStatus(admin, id, FeedbackStatus.Resolved),
    ).rejects.toBeInstanceOf(FeedbackNotFoundException);
    await expect(service.get(superAdmin, id)).resolves.toMatchObject({
      status: FeedbackStatus.Open,
    });

    await expect(
      service.setStatus(superAdmin, id, FeedbackStatus.Resolved),
    ).resolves.toMatchObject({ status: FeedbackStatus.Resolved });
  });
});

describe('who is told about a report', () => {
  it('is every admin who can still sign in', async () => {
    // Not the suspended admin, and not an ordinary member.
    await expect(
      service.reportRecipients(undefined).then((emails) => emails.sort()),
    ).resolves.toEqual(['admin@campus.local', 'root@campus.local']);
  });

  it('is never the account the report names', async () => {
    await expect(service.reportRecipients(admin.id)).resolves.toEqual([
      'root@campus.local',
    ]);
    // Naming somebody who is not an admin leaves nobody out.
    await expect(service.reportRecipients(grace.id)).resolves.toHaveLength(2);
  });
});
