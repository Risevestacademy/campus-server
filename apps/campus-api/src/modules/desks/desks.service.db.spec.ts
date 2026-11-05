import { DESKS_CHANGED_CHANNEL } from '@campus/session';
import { PGlite } from '@electric-sql/pglite';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { AuditAction, AuditSubjectType, auditLog } from '../audit/schema.js';
import { SessionIssuer } from '../auth/session-issuer.js';
import { CohortMembersService } from '../cohorts/cohort-members.service.js';
import { CohortNotFoundException } from '../cohorts/cohorts.exceptions.js';
import { MembershipEndAction } from '../cohorts/dto/end-membership.dto.js';
import {
  CohortRole,
  StudentStatus,
  cohortMembers,
  cohortTracks,
  cohorts,
} from '../cohorts/schema.js';
import { maps } from '../maps/schema.js';
import { tracks } from '../tracks/schema.js';
import { SystemRole, users } from '../users/schema.js';
import { UserRolesService } from '../users/user-roles.service.js';
import { UserStatusService } from '../users/user-status.service.js';
import {
  DeskConflictException,
  DeskForbiddenException,
  DeskNotFoundException,
} from './desks.exceptions.js';
import { DesksService } from './desks.service.js';
import { deskClaims, desks } from './schema.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);

const db = drizzle(new PGlite());
const service = new DesksService(db as never);
const issuer = new SessionIssuer(
  {} as never,
  db as never,
  {} as never,
  {} as never,
);

let cohortA: string;
let cohortB: string;
let ada: AuthenticatedUser;
let grace: AuthenticatedUser;
let guest: AuthenticatedUser;
let admin: AuthenticatedUser;
let outsider: AuthenticatedUser;

const person = async (
  email: string,
  systemRole = SystemRole.User,
): Promise<AuthenticatedUser> => {
  const [row] = await db
    .insert(users)
    .values({ email, systemRole, displayName: email.split('@')[0] })
    .returning();
  return { id: row.id, email: row.email, systemRole: row.systemRole };
};

const join = (
  cohortId: string,
  user: AuthenticatedUser,
  role: CohortRole,
  extra: Partial<typeof cohortMembers.$inferInsert> = {},
) =>
  db
    .insert(cohortMembers)
    .values({ cohortId, userId: user.id, role, ...extra });

/** Every claim, as `desk:holder:reason`, oldest first. */
const claims = async () =>
  (
    await db
      .select({
        desk: desks.key,
        email: users.email,
        reason: deskClaims.releaseReason,
      })
      .from(deskClaims)
      .innerJoin(desks, eq(desks.id, deskClaims.deskId))
      .innerJoin(users, eq(users.id, deskClaims.userId))
      .orderBy(asc(deskClaims.claimedAt), asc(deskClaims.id))
  ).map(
    (row) => `${row.desk}:${row.email.split('@')[0]}:${row.reason ?? 'open'}`,
  );

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (err: unknown) => err,
  );
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(
    sql`truncate audit_log, desk_claims, desks, maps, cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
  );
  const [campus] = await db
    .insert(maps)
    .values({ key: 'campus', name: 'Campus', isEntry: true })
    .returning();
  await db.insert(desks).values([
    { mapId: campus.id, key: 'desk_a' },
    { mapId: campus.id, key: 'desk_b' },
    { mapId: campus.id, key: 'desk_old', retiredAt: new Date() },
  ]);
  const [a, b] = await db
    .insert(cohorts)
    .values([
      { name: 'Cohort A', code: 'CA' },
      { name: 'Cohort B', code: 'CB' },
    ])
    .returning();
  [cohortA, cohortB] = [a.id, b.id];
  const [track] = await db
    .insert(tracks)
    .values({ name: 'Software Engineering', code: 'SE' })
    .returning();
  const [run] = await db
    .insert(cohortTracks)
    .values({ cohortId: cohortA, trackId: track.id })
    .returning();

  ada = await person('ada@campus.local');
  grace = await person('grace@campus.local');
  guest = await person('guest@campus.local');
  admin = await person('admin@campus.local', SystemRole.Admin);
  outsider = await person('outsider@campus.local');
  await join(cohortA, ada, CohortRole.Student, {
    cohortTrackId: run.id,
    status: StudentStatus.Active,
  });
  await join(cohortA, grace, CohortRole.Mentor);
  await join(cohortB, grace, CohortRole.Mentor);
  await join(cohortA, guest, CohortRole.Guest, {
    accessExpiresAt: new Date(Date.now() + 86_400_000),
  });
});

describe('listing', () => {
  it('shows every desk on the map with its holder in this cohort only', async () => {
    await service.claim(ada, cohortA, 'desk_a');
    await service.claim(grace, cohortB, 'desk_b');

    await expect(service.list(grace, cohortA)).resolves.toEqual([
      {
        key: 'desk_a',
        mapKey: 'campus',
        holder: { id: ada.id, displayName: 'ada' },
        claimedAt: expect.any(Date),
      },
      { key: 'desk_b', mapKey: 'campus', holder: null, claimedAt: null },
    ]);
  });

  it('is open to guests and to admins with no place in the cohort', async () => {
    await expect(service.list(guest, cohortA)).resolves.toHaveLength(2);
    await expect(service.list(admin, cohortA)).resolves.toHaveLength(2);
  });

  it('is refused to anybody else, and tells an admin of a cohort that is not there', async () => {
    expect(await rejection(service.list(outsider, cohortA))).toBeInstanceOf(
      DeskForbiddenException,
    );
    expect(
      await rejection(
        service.list(admin, '99999999-9999-4999-8999-999999999999'),
      ),
    ).toBeInstanceOf(CohortNotFoundException);
  });
});

describe('claiming', () => {
  it('gives the desk to the caller, and changes nothing when they claim it again', async () => {
    const first = await service.claim(ada, cohortA, 'desk_a');
    const again = await service.claim(ada, cohortA, 'desk_a');

    expect(first.holder?.id).toBe(ada.id);
    expect(again).toEqual(first);
    await expect(claims()).resolves.toEqual(['desk_a:ada:open']);
  });

  it('moves the caller from the desk they hold to the one they claim', async () => {
    await service.claim(ada, cohortA, 'desk_a');

    const moved = await service.claim(ada, cohortA, 'desk_b');

    expect(moved).toMatchObject({ key: 'desk_b', holder: { id: ada.id } });
    await expect(claims()).resolves.toEqual([
      'desk_a:ada:released',
      'desk_b:ada:open',
    ]);
  });

  it('refuses a desk somebody else holds in the cohort', async () => {
    await service.claim(ada, cohortA, 'desk_a');

    expect(
      await rejection(service.claim(grace, cohortA, 'desk_a')),
    ).toBeInstanceOf(DeskConflictException);
  });

  it('lets one person hold a desk in each of their cohorts, and the same desk have a holder in each', async () => {
    await service.claim(grace, cohortA, 'desk_a');
    await service.claim(grace, cohortB, 'desk_a');

    await expect(claims()).resolves.toEqual([
      'desk_a:grace:open',
      'desk_a:grace:open',
    ]);
  });

  it('lets an admin claim in a cohort they are not a member of', async () => {
    await expect(
      service.claim(admin, cohortA, 'desk_a'),
    ).resolves.toMatchObject({ holder: { id: admin.id } });
  });

  it('turns away guests, outsiders, ended members and students who are not active', async () => {
    const ended = await person('ended@campus.local');
    await join(cohortB, ended, CohortRole.Mentor, { leftAt: new Date() });
    await db
      .update(cohortMembers)
      .set({ status: StudentStatus.Deferred })
      .where(eq(cohortMembers.userId, ada.id));

    for (const [who, cohortId] of [
      [guest, cohortA],
      [outsider, cohortA],
      [ended, cohortB],
      [ada, cohortA],
    ] as const) {
      expect(
        await rejection(service.claim(who, cohortId, 'desk_a')),
      ).toBeInstanceOf(DeskForbiddenException);
    }
    await expect(claims()).resolves.toEqual([]);
  });

  it('knows no desk that is retired or was never drawn', async () => {
    for (const key of ['desk_old', 'nowhere']) {
      expect(await rejection(service.claim(ada, cohortA, key))).toBeInstanceOf(
        DeskNotFoundException,
      );
    }
  });
});

describe('releasing', () => {
  it('lets the holder go of their own desk', async () => {
    await service.claim(ada, cohortA, 'desk_a');

    const released = await service.release(ada, cohortA, 'desk_a', {
      actorUserId: ada.id,
    });

    expect(released.holder).toBeNull();
    await expect(claims()).resolves.toEqual(['desk_a:ada:released']);
    await expect(db.select().from(auditLog)).resolves.toEqual([]);
  });

  it("lets an admin free somebody else's desk, and records it", async () => {
    await service.claim(ada, cohortA, 'desk_a');

    await service.release(admin, cohortA, 'desk_a', {
      actorUserId: admin.id,
      correlationId: '33333333-3333-4333-8333-333333333333',
    });

    await expect(claims()).resolves.toEqual(['desk_a:ada:freed_by_admin']);
    const [claim] = await db.select().from(deskClaims);
    await expect(db.select().from(auditLog)).resolves.toEqual([
      expect.objectContaining({
        actorUserId: admin.id,
        action: AuditAction.DeskFreed,
        subjectType: AuditSubjectType.DeskClaim,
        subjectId: claim.id,
        details: { cohortId: cohortA, deskKey: 'desk_a', holderId: ada.id },
      }),
    ]);
  });

  it('turns guests away, as claiming does', async () => {
    expect(
      await rejection(
        service.release(guest, cohortA, 'desk_a', { actorUserId: guest.id }),
      ),
    ).toBeInstanceOf(DeskForbiddenException);
  });

  it("refuses a member freeing somebody else's desk", async () => {
    await service.claim(ada, cohortA, 'desk_a');

    expect(
      await rejection(
        service.release(grace, cohortA, 'desk_a', { actorUserId: grace.id }),
      ),
    ).toBeInstanceOf(DeskForbiddenException);
    await expect(claims()).resolves.toEqual(['desk_a:ada:open']);
  });

  it('answers a desk nobody holds as it is, so a retried release succeeds', async () => {
    await service.claim(ada, cohortA, 'desk_a');
    await service.release(ada, cohortA, 'desk_a', { actorUserId: ada.id });

    await expect(
      service.release(ada, cohortA, 'desk_a', { actorUserId: ada.id }),
    ).resolves.toMatchObject({ key: 'desk_a', holder: null });
    await expect(claims()).resolves.toEqual(['desk_a:ada:released']);
  });

  it('decides on the account, not a session that still says admin', async () => {
    await service.claim(ada, cohortA, 'desk_a');
    await join(cohortA, admin, CohortRole.Mentor);
    await db
      .update(users)
      .set({ systemRole: SystemRole.User })
      .where(eq(users.id, admin.id));

    expect(
      await rejection(
        service.release(admin, cohortA, 'desk_a', { actorUserId: admin.id }),
      ),
    ).toBeInstanceOf(DeskForbiddenException);
    await expect(db.select().from(auditLog)).resolves.toEqual([]);
  });
});

describe('a membership ending', () => {
  it('lets go of the desk the person held in that cohort, and only that one', async () => {
    await service.claim(grace, cohortA, 'desk_a');
    await service.claim(grace, cohortB, 'desk_b');

    await new CohortMembersService(db as never).endMembership(
      cohortA,
      grace.id,
      MembershipEndAction.Remove,
      undefined,
      { actorUserId: admin.id },
      async () => undefined,
    );

    await expect(claims()).resolves.toEqual([
      'desk_a:grace:enrolment_ended',
      'desk_b:grace:open',
    ]);
  });
});

describe('an account losing what let it hold a desk', () => {
  it('ends every claim of a suspended account, and refuses its next', async () => {
    await service.claim(grace, cohortA, 'desk_a');
    await service.claim(grace, cohortB, 'desk_b');

    await new UserStatusService(db as never, issuer).suspend(admin, grace.id);

    await expect(claims()).resolves.toEqual([
      'desk_a:grace:account_suspended',
      'desk_b:grace:account_suspended',
    ]);
    expect(
      await rejection(service.claim(grace, cohortA, 'desk_a')),
    ).toBeInstanceOf(DeskForbiddenException);
  });

  it('ends a demoted admin’s claims only where they hold no place to claim with', async () => {
    const other = await person('other@campus.local', SystemRole.Admin);
    await join(cohortB, other, CohortRole.Mentor);
    await service.claim(other, cohortA, 'desk_a');
    await service.claim(other, cohortB, 'desk_b');

    await new UserRolesService(db as never, issuer).setSystemRole(
      admin,
      other.id,
      SystemRole.User,
    );

    await expect(claims()).resolves.toEqual([
      'desk_a:other:admin_role_removed',
      'desk_b:other:open',
    ]);
    // Their session still says admin; the account does not.
    expect(
      await rejection(service.claim(other, cohortA, 'desk_b')),
    ).toBeInstanceOf(DeskForbiddenException);
  });
});

describe('telling world', () => {
  const listening = async () => {
    const heard: string[] = [];
    const stop = await (db.$client as PGlite).listen(
      DESKS_CHANGED_CHANNEL,
      (payload) => heard.push(payload),
    );
    return { heard, stop };
  };

  it('names the cohort on a claim, a move, a release and a membership ending', async () => {
    const { heard, stop } = await listening();
    try {
      await service.claim(grace, cohortB, 'desk_a');
      await service.claim(grace, cohortB, 'desk_b');
      await service.release(grace, cohortB, 'desk_b', {
        actorUserId: grace.id,
      });
      await service.claim(grace, cohortA, 'desk_a');
      await new CohortMembersService(db as never).endMembership(
        cohortA,
        grace.id,
        MembershipEndAction.Remove,
        undefined,
        { actorUserId: admin.id },
        async () => undefined,
      );
      await vi.waitFor(() => expect(heard).toHaveLength(5));
      expect(heard).toEqual([cohortB, cohortB, cohortB, cohortA, cohortA]);
    } finally {
      await stop();
    }
  });

  it('says nothing for a claim that changes nothing', async () => {
    await service.claim(ada, cohortA, 'desk_a');
    const { heard, stop } = await listening();
    try {
      await service.claim(ada, cohortA, 'desk_a');
      await db.execute(
        sql`select pg_notify(${DESKS_CHANGED_CHANNEL}, 'marker')`,
      );
      await vi.waitFor(() => expect(heard).toContain('marker'));
      expect(heard).toEqual(['marker']);
    } finally {
      await stop();
    }
  });
});
