import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import type { Db } from '../../infra/database/database.constants.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { AuditAction, AuditSubjectType, auditLog } from '../audit/schema.js';
import {
  CohortRole,
  cohortMembers,
  cohortTracks,
  cohorts,
} from '../cohorts/schema.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { notifications } from '../notifications/schema.js';
import { tracks } from '../tracks/schema.js';
import { SystemRole, users } from '../users/schema.js';
import { NoticeScope, notices } from './schema.js';
import { NoticesService } from './notices.service.js';
import {
  NoticeConflictException,
  NoticeForbiddenException,
  NoticeInvalidArgumentException,
  NoticeNotFoundException,
} from './notices.exceptions.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);

const pglite = drizzle(new PGlite(), {
  schema: { users, tracks, cohorts, cohortTracks, notices, auditLog },
});
const service = new NoticesService(
  pglite as unknown as Db,
  new NotificationsService(pglite as unknown as Db),
);

let adminUser: AuthenticatedUser;
let professorUser: AuthenticatedUser;
let mentorUser: AuthenticatedUser;
let cohortId: string;
let cohortTrackId: string;
let professorUserId: string;
let mentorUserId: string;

const audit = { actorUserId: null, correlationId: undefined };

beforeAll(async () => {
  await migrate(pglite, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await pglite.execute(
    sql`truncate audit_log, notices, cohort_tracks, cohorts, tracks, users cascade`,
  );

  const [admin] = await pglite
    .insert(users)
    .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
    .returning();
  adminUser = {
    id: admin.id,
    email: admin.email,
    systemRole: admin.systemRole,
  };

  const [professor] = await pglite
    .insert(users)
    .values({ email: 'prof@campus.local', systemRole: SystemRole.User })
    .returning();
  professorUserId = professor.id;
  professorUser = {
    id: professor.id,
    email: professor.email,
    systemRole: professor.systemRole,
  };

  const [mentor] = await pglite
    .insert(users)
    .values({ email: 'mentor@campus.local', systemRole: SystemRole.User })
    .returning();
  mentorUserId = mentor.id;
  mentorUser = {
    id: mentor.id,
    email: mentor.email,
    systemRole: mentor.systemRole,
  };

  const [cohort] = await pglite
    .insert(cohorts)
    .values({ name: 'Cohort 1', code: 'C1' })
    .returning();
  cohortId = cohort.id;

  const [track] = await pglite
    .insert(tracks)
    .values({ name: 'Backend', code: 'BACKEND' })
    .returning();

  const [ct] = await pglite
    .insert(cohortTracks)
    .values({ cohortId, trackId: track.id })
    .returning();
  cohortTrackId = ct.id;

  // Professor is a professor of the cohort.
  await pglite.insert(cohortMembers).values({
    cohortId,
    userId: professorUserId,
    role: CohortRole.Professor,
  });

  // Mentor is a mentor of the cohort.
  await pglite.insert(cohortMembers).values({
    cohortId,
    userId: mentorUserId,
    role: CohortRole.Mentor,
  });
});

describe('create', () => {
  it('admin creates a campus-wide notice', async () => {
    const notice = await service.create(
      {
        title: 'Welcome',
        body: 'Welcome to campus.',
        scope: NoticeScope.Campus,
      },
      adminUser,
      { ...audit, actorUserId: adminUser.id },
    );

    expect(notice.title).toBe('Welcome');
    expect(notice.scope).toBe(NoticeScope.Campus);
    expect(notice.cohortId).toBeNull();
    expect(notice.cohortTrackId).toBeNull();
    expect(notice.pinned).toBe(false);
    expect(notice.removedAt).toBeNull();

    const [entry] = await pglite
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, AuditAction.NoticeCreated));
    expect(entry).toBeDefined();
    expect(entry.subjectType).toBe(AuditSubjectType.Notice);
    expect(entry.subjectId).toBe(notice.id);
  });

  it('professor creates a cohort-track notice in their cohort', async () => {
    const notice = await service.create(
      {
        title: 'Track update',
        body: 'New material posted.',
        scope: NoticeScope.CohortTrack,
        cohortId,
        cohortTrackId,
      },
      professorUser,
      { ...audit, actorUserId: professorUser.id },
    );

    expect(notice.scope).toBe(NoticeScope.CohortTrack);
    expect(notice.cohortId).toBe(cohortId);
    expect(notice.cohortTrackId).toBe(cohortTrackId);
  });

  it("notifies every live member in the notice's scope, auditing only the notice", async () => {
    const [outsider] = await pglite
      .insert(users)
      .values({ email: 'outsider@campus.local' })
      .returning();
    const [otherCohort] = await pglite
      .insert(cohorts)
      .values({ name: 'Cohort 2', code: 'C2' })
      .returning();
    await pglite.insert(cohortMembers).values({
      cohortId: otherCohort.id,
      userId: outsider.id,
      role: CohortRole.Mentor,
    });

    const notice = await service.create(
      {
        title: 'Heads up',
        body: 'Read this.',
        scope: NoticeScope.Cohort,
        cohortId,
      },
      professorUser,
      { ...audit, actorUserId: professorUser.id },
    );

    const sent = await pglite
      .select()
      .from(notifications)
      .where(eq(notifications.referenceId, notice.id));
    expect(sent.map((row) => row.recipientId).sort()).toEqual(
      [professorUserId, mentorUserId].sort(),
    );
    expect(sent.every((row) => row.kind === 'notice_posted')).toBe(true);
    expect(await pglite.select().from(auditLog)).toHaveLength(1);
  });

  it('notifies nobody when the notice is refused', async () => {
    await expect(
      service.create(
        { title: 'No', body: 'No.', scope: NoticeScope.Cohort, cohortId },
        mentorUser,
        { ...audit, actorUserId: mentorUser.id },
      ),
    ).rejects.toBeInstanceOf(NoticeForbiddenException);

    expect(await pglite.select().from(notifications)).toEqual([]);
  });

  it('mentor is refused', async () => {
    await expect(
      service.create(
        {
          title: 'Nope',
          body: 'Should fail.',
          scope: NoticeScope.Cohort,
          cohortId,
        },
        mentorUser,
        { ...audit, actorUserId: mentorUser.id },
      ),
    ).rejects.toThrow(NoticeForbiddenException);
  });

  it('professor cannot post campus-wide', async () => {
    await expect(
      service.create(
        {
          title: 'Nope',
          body: 'Should fail.',
          scope: NoticeScope.Campus,
        },
        professorUser,
        { ...audit, actorUserId: professorUser.id },
      ),
    ).rejects.toThrow(NoticeForbiddenException);
  });

  it('rejects campus notice that names a cohort', async () => {
    await expect(
      service.create(
        {
          title: 'Bad',
          body: 'Scope mismatch.',
          scope: NoticeScope.Campus,
          cohortId,
        },
        adminUser,
        { ...audit, actorUserId: adminUser.id },
      ),
    ).rejects.toThrow(NoticeInvalidArgumentException);
  });

  it('rejects cohort notice without a cohort', async () => {
    await expect(
      service.create(
        {
          title: 'Bad',
          body: 'Missing cohort.',
          scope: NoticeScope.Cohort,
        },
        adminUser,
        { ...audit, actorUserId: adminUser.id },
      ),
    ).rejects.toThrow(NoticeInvalidArgumentException);
  });

  it('rejects cohort-track notice with wrong cohort for the track', async () => {
    const [otherCohort] = await pglite
      .insert(cohorts)
      .values({ name: 'Cohort 2', code: 'C2' })
      .returning();

    await expect(
      service.create(
        {
          title: 'Bad',
          body: 'Wrong cohort for track.',
          scope: NoticeScope.CohortTrack,
          cohortId: otherCohort.id,
          cohortTrackId,
        },
        adminUser,
        { ...audit, actorUserId: adminUser.id },
      ),
    ).rejects.toThrow(NoticeInvalidArgumentException);
  });
});

describe('update', () => {
  it('changes only title and body', async () => {
    const notice = await service.create(
      {
        title: 'Original',
        body: 'Original body.',
        scope: NoticeScope.Campus,
      },
      adminUser,
      { ...audit, actorUserId: adminUser.id },
    );

    const updated = await service.update(
      notice.id,
      { title: 'Edited', body: 'Edited body.' },
      adminUser,
      { ...audit, actorUserId: adminUser.id },
    );

    expect(updated.title).toBe('Edited');
    expect(updated.body).toBe('Edited body.');
    expect(updated.scope).toBe(NoticeScope.Campus);

    const entries = await pglite
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, AuditAction.NoticeUpdated));
    expect(entries).toHaveLength(1);
  });

  it('no-op when nothing changed', async () => {
    const notice = await service.create(
      {
        title: 'Same',
        body: 'Same body.',
        scope: NoticeScope.Campus,
      },
      adminUser,
      { ...audit, actorUserId: adminUser.id },
    );

    const result = await service.update(notice.id, {}, adminUser, {
      ...audit,
      actorUserId: adminUser.id,
    });

    expect(result.id).toBe(notice.id);

    const entries = await pglite
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, AuditAction.NoticeUpdated));
    expect(entries).toHaveLength(0);
  });

  it('rejects update of a removed notice', async () => {
    const notice = await service.create(
      {
        title: 'Will be removed',
        body: 'Temp.',
        scope: NoticeScope.Campus,
      },
      adminUser,
      { ...audit, actorUserId: adminUser.id },
    );

    await service.remove(notice.id, adminUser, {
      ...audit,
      actorUserId: adminUser.id,
    });

    await expect(
      service.update(notice.id, { title: 'Nope' }, adminUser, {
        ...audit,
        actorUserId: adminUser.id,
      }),
    ).rejects.toThrow(NoticeNotFoundException);
  });
});

describe('pin', () => {
  it('pins and unpins a notice', async () => {
    const notice = await service.create(
      {
        title: 'Pinnable',
        body: 'Body.',
        scope: NoticeScope.Campus,
      },
      adminUser,
      { ...audit, actorUserId: adminUser.id },
    );

    const pinned = await service.pin(notice.id, true, adminUser, {
      ...audit,
      actorUserId: adminUser.id,
    });
    expect(pinned.pinned).toBe(true);

    const unpinned = await service.pin(notice.id, false, adminUser, {
      ...audit,
      actorUserId: adminUser.id,
    });
    expect(unpinned.pinned).toBe(false);

    const entries = await pglite
      .select()
      .from(auditLog)
      .where(
        sql`${auditLog.action} in (${sql.raw(`'${AuditAction.NoticePinned}'`)}, ${sql.raw(`'${AuditAction.NoticeUnpinned}'`)})`,
      );
    expect(entries).toHaveLength(2);
  });

  it('refuses to pin a 4th notice in the same scope', async () => {
    for (let i = 0; i < 3; i++) {
      const n = await service.create(
        {
          title: `Pin ${i}`,
          body: `Body ${i}`,
          scope: NoticeScope.Campus,
        },
        adminUser,
        { ...audit, actorUserId: adminUser.id },
      );
      await service.pin(n.id, true, adminUser, {
        ...audit,
        actorUserId: adminUser.id,
      });
    }

    const fourth = await service.create(
      {
        title: 'Pin 4',
        body: 'Body 4',
        scope: NoticeScope.Campus,
      },
      adminUser,
      { ...audit, actorUserId: adminUser.id },
    );

    await expect(
      service.pin(fourth.id, true, adminUser, {
        ...audit,
        actorUserId: adminUser.id,
      }),
    ).rejects.toThrow(NoticeConflictException);
  });

  it('pin limit is per scope, not global', async () => {
    for (let i = 0; i < 3; i++) {
      const n = await service.create(
        {
          title: `Campus pin ${i}`,
          body: `Body ${i}`,
          scope: NoticeScope.Campus,
        },
        adminUser,
        { ...audit, actorUserId: adminUser.id },
      );
      await service.pin(n.id, true, adminUser, {
        ...audit,
        actorUserId: adminUser.id,
      });
    }

    const cohortNotice = await service.create(
      {
        title: 'Cohort pin',
        body: 'Body',
        scope: NoticeScope.Cohort,
        cohortId,
      },
      adminUser,
      { ...audit, actorUserId: adminUser.id },
    );

    const pinned = await service.pin(cohortNotice.id, true, adminUser, {
      ...audit,
      actorUserId: adminUser.id,
    });
    expect(pinned.pinned).toBe(true);
  });
});

describe('remove', () => {
  it('soft-deletes a notice', async () => {
    const notice = await service.create(
      {
        title: 'To remove',
        body: 'Body.',
        scope: NoticeScope.Campus,
      },
      adminUser,
      { ...audit, actorUserId: adminUser.id },
    );

    await service.remove(notice.id, adminUser, {
      ...audit,
      actorUserId: adminUser.id,
    });

    const [row] = await pglite
      .select()
      .from(notices)
      .where(eq(notices.id, notice.id));
    expect(row.removedAt).not.toBeNull();
    expect(row.pinned).toBe(false);

    const [entry] = await pglite
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, AuditAction.NoticeRemoved));
    expect(entry).toBeDefined();
    expect(entry.subjectId).toBe(notice.id);
  });

  it('cannot remove an already-removed notice', async () => {
    const notice = await service.create(
      {
        title: 'Double remove',
        body: 'Body.',
        scope: NoticeScope.Campus,
      },
      adminUser,
      { ...audit, actorUserId: adminUser.id },
    );

    await service.remove(notice.id, adminUser, {
      ...audit,
      actorUserId: adminUser.id,
    });

    await expect(
      service.remove(notice.id, adminUser, {
        ...audit,
        actorUserId: adminUser.id,
      }),
    ).rejects.toThrow(NoticeNotFoundException);
  });
});
