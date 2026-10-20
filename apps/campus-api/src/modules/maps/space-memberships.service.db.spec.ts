import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { writeAuditEntry } from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType, auditLog } from '../audit/schema.js';
import { cohortTracks, cohorts } from '../cohorts/schema.js';
import { tracks } from '../tracks/schema.js';
import { SystemRole, users } from '../users/schema.js';
import { SpaceMembershipSubjectType } from './dto/space-membership.dto.js';
import {
  SpaceMembershipAlreadyEndedException,
  SpaceMembershipAlreadyLiveException,
  SpaceMembershipInvalidArgumentException,
  SpaceMembershipNotFoundException,
  SpaceMembershipNotStartedException,
  SpaceMembershipSubjectNotFoundException,
  SpaceNotFoundException,
  SpaceRetiredException,
} from './maps.exceptions.js';
import { SpaceMembershipsService } from './space-memberships.service.js';
import {
  AudioMode,
  SpaceAccess,
  SpaceKind,
  maps,
  spaceMemberships,
  spaces,
} from './schema.js';

/**
 * Granting and ending access, against a real PostgreSQL engine with the
 * committed migrations applied — for the same reason as schema.db.spec.ts:
 * what the service refuses is only as good as it holds under concurrency,
 * so it is shown here beside the rules the database keeps for itself. The
 * audit entries are part of what is shown: a grant that logs nothing is a
 * failed grant, and the transaction is what makes the two one act.
 */
const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);

// The audit entry is written in the same transaction as the row. The test
// that breaks it says what happens when the log cannot be written: nothing
// is granted at all.
vi.mock('../audit/audit-log.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../audit/audit-log.js')>();
  return { ...actual, writeAuditEntry: vi.fn(actual.writeAuditEntry) };
});

const db = drizzle(new PGlite(), {
  schema: { users, tracks, cohorts, cohortTracks, maps, spaces },
});

const service = new SpaceMembershipsService(db as never);

/** The times every test grants and ends at, so nothing leans on the clock. */
const GRANT_AT = new Date('2026-10-19T12:00:00.000Z');
const END_AT = new Date('2026-10-19T12:01:00.000Z');
const LATER = new Date('2026-10-19T12:02:00.000Z');

/** Nobody's id, in the shape the service is handed an admin in. */
const NOBODY = { actorUserId: '', correlationId: 'req-1' };
type Actor = typeof NOBODY;

let actor: Actor;
let memberId: string;
let otherId: string;
let spaceId: string;
let retiredSpaceId: string;
let cohortTrackId: string;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  vi.mocked(writeAuditEntry).mockClear();
  await db.execute(
    sql`truncate audit_log, space_memberships, spaces, maps, cohort_tracks, cohorts, tracks, users cascade`,
  );

  const [map] = await db
    .insert(maps)
    .values({ key: 'campus', name: 'Campus', isEntry: true })
    .returning();
  const [room] = await db
    .insert(spaces)
    .values({
      mapId: map.id,
      key: 'mentor-pod',
      name: 'Mentor Pod',
      kind: SpaceKind.MentorPod,
      audioMode: AudioMode.Proximity,
      access: SpaceAccess.Invite,
    })
    .returning();
  const [retired] = await db
    .insert(spaces)
    .values({
      mapId: map.id,
      key: 'old-pod',
      name: 'Old Pod',
      audioMode: AudioMode.Proximity,
      access: SpaceAccess.Invite,
      retiredAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    .returning();
  spaceId = room.id;
  retiredSpaceId = retired.id;

  const [admin, member, other] = await db
    .insert(users)
    .values([
      { email: 'admin@campus.local', systemRole: SystemRole.Admin },
      { email: 'member@campus.local' },
      { email: 'other@campus.local' },
    ])
    .returning();
  actor = { actorUserId: admin.id, correlationId: 'req-1' };
  memberId = member.id;
  otherId = other.id;

  const [track] = await db
    .insert(tracks)
    .values({ name: 'Frontend', code: 'FE' })
    .returning();
  const [cohort] = await db
    .insert(cohorts)
    .values({ name: 'Cohort 1', code: 'C1' })
    .returning();
  const [run] = await db
    .insert(cohortTracks)
    .values({ cohortId: cohort.id, trackId: track.id })
    .returning();
  cohortTrackId = run.id;
});

/** One membership row for a person, straight into the table. */
async function givenTo(userId: string, from: Date, to: Date | null) {
  const [row] = await db
    .insert(spaceMemberships)
    .values({
      spaceId,
      userId,
      grantedBy: actor.actorUserId,
      validFrom: from,
      validTo: to,
    })
    .returning();
  return row;
}

/** Every membership row on the space, oldest grant first. */
const rows = () =>
  db
    .select()
    .from(spaceMemberships)
    .orderBy(spaceMemberships.validFrom, spaceMemberships.id);

describe('granting access to a space', () => {
  it('grants a person access and writes the audit entry naming the admin', async () => {
    const answer = await service.grant(
      spaceId,
      { userId: memberId },
      actor,
      GRANT_AT,
    );

    expect(answer).toMatchObject({
      spaceId,
      subject: {
        type: SpaceMembershipSubjectType.User,
        userId: memberId,
        email: 'member@campus.local',
        displayName: null,
      },
      grantedBy: actor.actorUserId,
      validTo: null,
      live: true,
    });

    const [row] = await db
      .select()
      .from(spaceMemberships)
      .where(eq(spaceMemberships.id, answer.id));
    expect(row).toMatchObject({
      spaceId,
      userId: memberId,
      cohortTrackId: null,
      grantedBy: actor.actorUserId,
      validTo: null,
    });
    // A grant starts when it is given: the span covers the moment of the
    // request and nothing before it.
    expect(row.validFrom.getTime()).toBe(GRANT_AT.getTime());

    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.subjectId, answer.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorUserId: actor.actorUserId,
      action: AuditAction.SpaceMembershipGranted,
      subjectType: AuditSubjectType.SpaceMembership,
      subjectId: answer.id,
      spaceId,
      correlationId: 'req-1',
    });
    expect(entries[0].details).toMatchObject({
      userId: memberId,
      cohortTrackId: null,
      validTo: null,
    });
  });

  it('grants a cohort track, and the answer names the cohort that runs it', async () => {
    const answer = await service.grant(
      spaceId,
      { cohortTrackId },
      actor,
      GRANT_AT,
    );

    expect(answer.subject).toEqual({
      type: SpaceMembershipSubjectType.CohortTrack,
      cohortTrackId,
      trackName: 'Frontend',
      trackCode: 'FE',
      cohortId: expect.any(String),
      cohortName: 'Cohort 1',
    });
    const [row] = await rows();
    expect(row).toMatchObject({ cohortTrackId, userId: null });
  });

  it('carries an end date: live while the window is open, over once it passes', async () => {
    const answer = await service.grant(
      spaceId,
      { userId: memberId, validTo: END_AT.toISOString() },
      actor,
      GRANT_AT,
    );

    expect(answer.validTo).toEqual(END_AT);
    expect(answer.live).toBe(true);
    const [later] = await service.list(spaceId, LATER);
    expect(later.live).toBe(false);
  });

  it('refuses a subject that does not exist', async () => {
    await expect(
      service.grant(
        spaceId,
        { userId: '99999999-9999-4999-8999-999999999999' },
        actor,
        GRANT_AT,
      ),
    ).rejects.toBeInstanceOf(SpaceMembershipSubjectNotFoundException);
    await expect(
      service.grant(
        spaceId,
        { cohortTrackId: '99999999-9999-4999-8999-999999999999' },
        actor,
        GRANT_AT,
      ),
    ).rejects.toBeInstanceOf(SpaceMembershipSubjectNotFoundException);

    expect(await rows()).toHaveLength(0);
  });

  it('refuses a retired space, though its grants may still be ended', async () => {
    await expect(
      service.grant(retiredSpaceId, { userId: memberId }, actor, GRANT_AT),
    ).rejects.toBeInstanceOf(SpaceRetiredException);
    expect(await rows()).toHaveLength(0);
  });

  it('refuses no such space', async () => {
    await expect(
      service.grant(
        '99999999-9999-4999-8999-999999999999',
        { userId: memberId },
        actor,
        GRANT_AT,
      ),
    ).rejects.toBeInstanceOf(SpaceNotFoundException);
  });

  it('refuses both subjects, and refuses neither', async () => {
    await expect(
      service.grant(
        spaceId,
        { userId: memberId, cohortTrackId },
        actor,
        GRANT_AT,
      ),
    ).rejects.toBeInstanceOf(SpaceMembershipInvalidArgumentException);
    await expect(
      service.grant(spaceId, {}, actor, GRANT_AT),
    ).rejects.toBeInstanceOf(SpaceMembershipInvalidArgumentException);

    expect(await rows()).toHaveLength(0);
  });

  it('refuses an end date that has already passed, or is the moment itself', async () => {
    await expect(
      service.grant(
        spaceId,
        { userId: memberId, validTo: GRANT_AT.toISOString() },
        actor,
        GRANT_AT,
      ),
    ).rejects.toBeInstanceOf(SpaceMembershipInvalidArgumentException);
    await expect(
      service.grant(
        spaceId,
        { userId: memberId, validTo: '2020-01-01T00:00:00.000Z' },
        actor,
        GRANT_AT,
      ),
    ).rejects.toBeInstanceOf(SpaceMembershipInvalidArgumentException);

    expect(await rows()).toHaveLength(0);
  });

  it('refuses a second grant while one to the same subject is live', async () => {
    const first = await service.grant(
      spaceId,
      { userId: memberId },
      actor,
      GRANT_AT,
    );
    await expect(
      service.grant(spaceId, { userId: memberId }, actor, LATER),
    ).rejects.toBeInstanceOf(SpaceMembershipAlreadyLiveException);

    // Another subject is not caught by it: the track holds its own grant.
    const onTrack = await service.grant(
      spaceId,
      { cohortTrackId },
      actor,
      LATER,
    );
    const all = await rows();
    expect(all.map((row) => row.id)).toEqual([first.id, onTrack.id]);
  });

  it('allows granting again once the earlier grant has been ended', async () => {
    const first = await service.grant(
      spaceId,
      { userId: memberId },
      actor,
      GRANT_AT,
    );
    await service.end(spaceId, first.id, actor, END_AT);

    const second = await service.grant(
      spaceId,
      { userId: memberId },
      actor,
      LATER,
    );

    const all = await rows();
    expect(all).toHaveLength(2);
    // The ended row stays as the record, and the new grant sits beside it.
    expect(all.map((row) => row.id)).toEqual([first.id, second.id]);
    expect(all[0].validTo).toEqual(END_AT);
    expect(all[1].validTo).toBeNull();
  });

  it('does not wait for a grant that has run out to block a new one', async () => {
    // A window that closed by its own end date, without anybody ending it.
    const spent = await givenTo(
      memberId,
      new Date('2026-10-19T10:00:00.000Z'),
      new Date('2026-10-19T11:00:00.000Z'),
    );

    const answer = await service.grant(
      spaceId,
      { userId: memberId },
      actor,
      GRANT_AT,
    );

    expect(answer.live).toBe(true);
    const all = await rows();
    expect(all.map((row) => row.id)).toEqual([spent.id, answer.id]);
  });
});

describe('ending access to a space', () => {
  it('ends a grant, keeps the row, and writes the audit entry', async () => {
    const grant = await service.grant(
      spaceId,
      { userId: memberId },
      actor,
      GRANT_AT,
    );

    await service.end(spaceId, grant.id, actor, END_AT);

    // Not deleted: the row is the record that access was given.
    const [row] = await db
      .select()
      .from(spaceMemberships)
      .where(eq(spaceMemberships.id, grant.id));
    expect(row).toMatchObject({
      userId: memberId,
      grantedBy: actor.actorUserId,
      validTo: END_AT,
    });

    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.subjectId, grant.id));
    expect(entries.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        AuditAction.SpaceMembershipGranted,
        AuditAction.SpaceMembershipEnded,
      ]),
    );
    const ended = entries.find(
      (entry) => entry.action === AuditAction.SpaceMembershipEnded,
    );
    expect(ended).toMatchObject({
      actorUserId: actor.actorUserId,
      subjectType: AuditSubjectType.SpaceMembership,
      spaceId,
      correlationId: 'req-1',
    });
    // jsonb stores the instant as JSON did: as the string it was written as.
    expect(ended.details).toEqual({ endedAt: END_AT.toISOString() });

    const [listed] = await service.list(spaceId, LATER);
    expect(listed.live).toBe(false);
  });

  it('refuses to end the same grant twice', async () => {
    const grant = await service.grant(
      spaceId,
      { userId: memberId },
      actor,
      GRANT_AT,
    );
    await service.end(spaceId, grant.id, actor, END_AT);

    await expect(
      service.end(spaceId, grant.id, actor, LATER),
    ).rejects.toBeInstanceOf(SpaceMembershipAlreadyEndedException);
  });

  it('refuses no such grant, and one that belongs to another space', async () => {
    const grant = await service.grant(
      spaceId,
      { userId: memberId },
      actor,
      GRANT_AT,
    );
    await expect(
      service.end(
        spaceId,
        '99999999-9999-4999-8999-999999999999',
        actor,
        END_AT,
      ),
    ).rejects.toBeInstanceOf(SpaceMembershipNotFoundException);
    await expect(
      service.end(retiredSpaceId, grant.id, actor, END_AT),
    ).rejects.toBeInstanceOf(SpaceMembershipNotFoundException);

    const [row] = await rows();
    expect(row.validTo).toBeNull();
  });

  it('ends a grant on a retired space — taking access away is not giving it', async () => {
    const grant = await service.grant(
      spaceId,
      { userId: memberId },
      actor,
      GRANT_AT,
    );
    await db
      .update(spaces)
      .set({ retiredAt: LATER })
      .where(eq(spaces.id, spaceId));

    await service.end(spaceId, grant.id, actor, END_AT);

    const [row] = await rows();
    expect(row.validTo).toEqual(END_AT);
  });

  it('refuses a grant that has not started', async () => {
    const future = await givenTo(memberId, LATER, null);

    await expect(
      service.end(spaceId, future.id, actor, GRANT_AT),
    ).rejects.toBeInstanceOf(SpaceMembershipNotStartedException);

    const [row] = await rows();
    expect(row.validTo).toBeNull();
  });

  it('ends a grant opened and ended within the same millisecond without closing it at its own start', async () => {
    const grant = await service.grant(
      spaceId,
      { userId: memberId },
      actor,
      GRANT_AT,
    );

    await service.end(spaceId, grant.id, actor, GRANT_AT);

    // `valid_to > valid_from` is the window rule, and one tick past the open
    // is the least that satisfies it and still says the grant was over at
    // once.
    const [row] = await rows();
    expect(row.validTo.getTime()).toBe(GRANT_AT.getTime() + 1);
    expect(row.validTo.getTime()).toBeGreaterThan(row.validFrom.getTime());
  });
});

describe('listing a space’s grants', () => {
  it('lists every grant, ended ones included, with who holds it now', async () => {
    const live = await service.grant(
      spaceId,
      { userId: memberId },
      actor,
      GRANT_AT,
    );
    const spent = await givenTo(
      otherId,
      new Date('2026-10-19T10:00:00.000Z'),
      new Date('2026-10-19T11:00:00.000Z'),
    );
    const onTrack = await service.grant(
      spaceId,
      { cohortTrackId },
      actor,
      END_AT,
    );

    const listed = await service.list(spaceId, LATER);

    expect(listed.map((entry) => entry.id)).toEqual([
      spent.id,
      live.id,
      onTrack.id,
    ]);
    expect(listed.map((entry) => entry.live)).toEqual([false, true, true]);
    expect(listed[0].subject).toMatchObject({
      type: SpaceMembershipSubjectType.User,
      userId: otherId,
      email: 'other@campus.local',
    });
    expect(listed[2].subject).toMatchObject({
      type: SpaceMembershipSubjectType.CohortTrack,
      cohortTrackId,
      trackName: 'Frontend',
      cohortName: 'Cohort 1',
    });
  });

  it('lists a space with none as empty', async () => {
    await expect(service.list(spaceId, GRANT_AT)).resolves.toEqual([]);
  });

  it('refuses no such space', async () => {
    await expect(
      service.list('99999999-9999-4999-8999-999999999999', GRANT_AT),
    ).rejects.toBeInstanceOf(SpaceNotFoundException);
  });
});

describe('a grant and its audit entry are one act', () => {
  it('grants nothing when the audit entry cannot be written', async () => {
    vi.mocked(writeAuditEntry).mockRejectedValueOnce(new Error('audit down'));

    await expect(
      service.grant(spaceId, { userId: memberId }, actor, GRANT_AT),
    ).rejects.toThrow('audit down');

    expect(await rows()).toHaveLength(0);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it('ends nothing when the audit entry cannot be written', async () => {
    const grant = await service.grant(
      spaceId,
      { userId: memberId },
      actor,
      GRANT_AT,
    );
    vi.mocked(writeAuditEntry).mockRejectedValueOnce(new Error('audit down'));

    await expect(service.end(spaceId, grant.id, actor, END_AT)).rejects.toThrow(
      'audit down',
    );

    const [row] = await rows();
    expect(row.validTo).toBeNull();
  });
});
