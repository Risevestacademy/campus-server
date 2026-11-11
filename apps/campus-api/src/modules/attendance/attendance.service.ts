import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import {
  DRIZZLE,
  type Db,
  type DbExecutor,
} from '../../infra/database/database.constants.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import type { PaginatedResponseDto } from '../../shared/dto/paginated-response.dto.js';
import { InvalidArgumentException } from '../../shared/exceptions/access.exception.js';
import { writeAuditEntry, type AuditContext } from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType } from '../audit/schema.js';
import { isLiveMembership } from '../cohorts/cohort-members.service.js';
import { CohortNotFoundException } from '../cohorts/cohorts.exceptions.js';
import { CohortRole, cohortMembers, cohorts } from '../cohorts/schema.js';
import { mentorshipGroups } from '../mentorship-groups/schema.js';
import {
  RoomLinkAudience,
  roomLinkInstances,
  roomLinks,
} from '../room-links/schema.js';
import { UserStatus, hasAdminPowers, users } from '../users/schema.js';
import {
  AttendanceForbiddenException,
  AttendanceNotFoundException,
} from './attendance.exceptions.js';
import type {
  AttendanceClassDetailDto,
  AttendanceClassDto,
  AttendanceRowDto,
  CorrectAttendanceDto,
  ListAttendanceClassesQueryDto,
  StudentAttendanceDto,
  StudentAttendanceSummaryDto,
} from './dto/attendance.dto.js';
import {
  AttendanceSource,
  AttendanceStatus,
  attendance,
  attendanceOverrides,
  attendanceTallies,
} from './schema.js';

/** The classes a caller may read and correct in one cohort. */
type Scope =
  { admin: true } | { admin: false; trackIds: string[]; groupIds: string[] };

const windowSeconds = sql<number>`extract(epoch from ${attendanceTallies.endsAt} - ${attendanceTallies.startsAt})::int`;

export function percentage(seconds: number, outOf: number): number {
  return outOf > 0 ? Math.min(100, Math.floor((seconds * 100) / outOf)) : 0;
}

@Injectable()
export class AttendanceService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listClasses(
    user: AuthenticatedUser,
    cohortId: string,
    query: ListAttendanceClassesQueryDto,
    now = new Date(),
  ): Promise<PaginatedResponseDto<AttendanceClassDto>> {
    const scope = await this.staffScope(user, cohortId, now);
    const where = and(
      eq(roomLinks.cohortId, cohortId),
      visible(scope),
      query.from ? gte(attendanceTallies.startsAt, query.from) : undefined,
      query.to ? lt(attendanceTallies.startsAt, query.to) : undefined,
    );
    const [classes, [{ total }]] = await Promise.all([
      this.classes(where)
        .orderBy(
          desc(attendanceTallies.startsAt),
          asc(attendanceTallies.instanceId),
        )
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      this.db
        .select({ total: count() })
        .from(attendanceTallies)
        .innerJoin(
          roomLinkInstances,
          eq(roomLinkInstances.id, attendanceTallies.instanceId),
        )
        .innerJoin(roomLinks, eq(roomLinks.id, roomLinkInstances.roomLinkId))
        .where(where),
    ]);
    return {
      items: classes.map(toClassDto),
      meta: {
        page: query.page,
        perPage: query.perPage,
        total,
        totalPages: Math.ceil(total / query.perPage),
      },
    };
  }

  async getClass(
    user: AuthenticatedUser,
    instanceId: string,
    now = new Date(),
  ): Promise<AttendanceClassDetailDto> {
    const [found] = await this.classes(
      eq(attendanceTallies.instanceId, instanceId),
    );
    if (!found) {
      throw new AttendanceNotFoundException('No tallied class with that id', {
        instanceId,
      });
    }
    const scope = await this.staffScope(user, found.cohortId, now);
    if (!sees(scope, found)) {
      throw notYours(found.cohortId);
    }

    const students = await this.db
      .select({
        ...rowFields,
        firstName: users.firstName,
        lastName: users.lastName,
        displayName: users.displayName,
      })
      .from(attendance)
      .innerJoin(users, eq(users.id, attendance.userId))
      .where(eq(attendance.instanceId, instanceId))
      .orderBy(asc(users.firstName), asc(users.lastName), asc(users.id));

    return {
      ...toClassDto(found),
      students: students.map((row) => ({
        ...toRowDto(row, found.windowSeconds),
        firstName: row.firstName,
        lastName: row.lastName,
        displayName: row.displayName,
      })),
    };
  }

  async listStudents(
    user: AuthenticatedUser,
    cohortId: string,
    now = new Date(),
  ): Promise<StudentAttendanceSummaryDto[]> {
    const scope = await this.staffScope(user, cohortId, now);
    const rows = await this.db
      .select({
        userId: attendance.userId,
        firstName: users.firstName,
        lastName: users.lastName,
        displayName: users.displayName,
        ...tallyFields,
      })
      .from(attendance)
      .innerJoin(
        attendanceTallies,
        eq(attendanceTallies.instanceId, attendance.instanceId),
      )
      .innerJoin(
        roomLinkInstances,
        eq(roomLinkInstances.id, attendance.instanceId),
      )
      .innerJoin(roomLinks, eq(roomLinks.id, roomLinkInstances.roomLinkId))
      .innerJoin(users, eq(users.id, attendance.userId))
      .where(and(eq(roomLinks.cohortId, cohortId), visible(scope)))
      .groupBy(
        attendance.userId,
        users.firstName,
        users.lastName,
        users.displayName,
      )
      .orderBy(
        asc(users.firstName),
        asc(users.lastName),
        asc(attendance.userId),
      );
    return rows.map((row) => ({
      userId: row.userId,
      firstName: row.firstName,
      lastName: row.lastName,
      displayName: row.displayName,
      ...toTally(row),
    }));
  }

  async getStudent(
    user: AuthenticatedUser,
    cohortId: string,
    userId: string,
    now = new Date(),
  ): Promise<StudentAttendanceDto> {
    let scope: Scope;
    if (user.id === userId) {
      await this.isAdmin(user, cohortId, this.db);
      scope = { admin: true };
    } else {
      scope = await this.staffScope(user, cohortId, now);
    }

    const classes = await this.db
      .select({
        roomLinkId: roomLinks.id,
        title: roomLinks.title,
        audience: roomLinks.audience,
        startsAt: attendanceTallies.startsAt,
        endsAt: attendanceTallies.endsAt,
        windowSeconds,
        ...rowFields,
      })
      .from(attendance)
      .innerJoin(
        attendanceTallies,
        eq(attendanceTallies.instanceId, attendance.instanceId),
      )
      .innerJoin(
        roomLinkInstances,
        eq(roomLinkInstances.id, attendance.instanceId),
      )
      .innerJoin(roomLinks, eq(roomLinks.id, roomLinkInstances.roomLinkId))
      .where(
        and(
          eq(attendance.userId, userId),
          eq(roomLinks.cohortId, cohortId),
          visible(scope),
        ),
      )
      .orderBy(desc(attendanceTallies.startsAt), asc(attendance.id));

    const totals = {
      classes: 0,
      present: 0,
      partial: 0,
      absent: 0,
      seconds: 0,
      outOf: 0,
    };
    for (const row of classes) {
      totals.classes += 1;
      totals[row.status] += 1;
      totals.seconds += row.presentSeconds;
      totals.outOf += row.windowSeconds;
    }

    return {
      userId,
      classes: totals.classes,
      present: totals.present,
      partial: totals.partial,
      absent: totals.absent,
      percentage: percentage(totals.seconds, totals.outOf),
      runs: classes.map((row) => ({
        instanceId: row.instanceId,
        roomLinkId: row.roomLinkId,
        title: row.title,
        audience: row.audience,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        ...toRowDto(row, row.windowSeconds),
      })),
    };
  }

  async correct(
    user: AuthenticatedUser,
    attendanceId: string,
    body: CorrectAttendanceDto,
    audit: AuditContext,
    now = new Date(),
  ): Promise<AttendanceRowDto> {
    const reason = body.reason.trim();
    if (!reason) {
      throw new InvalidArgumentException('A correction needs a reason', {
        attendanceId,
      });
    }

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          ...rowFields,
          windowSeconds,
          cohortId: roomLinks.cohortId,
          spaceId: roomLinks.spaceId,
          audience: roomLinks.audience,
          cohortTrackId: roomLinks.cohortTrackId,
          mentorshipGroupId: roomLinks.mentorshipGroupId,
        })
        .from(attendance)
        .innerJoin(
          attendanceTallies,
          eq(attendanceTallies.instanceId, attendance.instanceId),
        )
        .innerJoin(
          roomLinkInstances,
          eq(roomLinkInstances.id, attendance.instanceId),
        )
        .innerJoin(roomLinks, eq(roomLinks.id, roomLinkInstances.roomLinkId))
        .where(eq(attendance.id, attendanceId))
        .for('update', { of: attendance });
      if (!row) {
        throw new AttendanceNotFoundException(
          'No attendance row with that id',
          { attendanceId },
        );
      }
      const scope = await this.staffScope(user, row.cohortId, now, tx);
      if (!sees(scope, row)) {
        throw notYours(row.cohortId);
      }
      if (row.status === body.status) {
        throw new InvalidArgumentException(
          `This attendance is already ${body.status}`,
          { attendanceId },
        );
      }

      const [updated] = await tx
        .update(attendance)
        .set({
          status: body.status,
          source: AttendanceSource.Override,
          updatedAt: now,
        })
        .where(eq(attendance.id, attendanceId))
        .returning(rowFields);
      await tx.insert(attendanceOverrides).values({
        attendanceId,
        changedBy: user.id,
        oldStatus: row.status,
        newStatus: body.status,
        reason,
        createdAt: now,
      });
      await writeAuditEntry(tx, {
        ...audit,
        spaceId: row.spaceId,
        action: AuditAction.AttendanceCorrected,
        subject: { type: AuditSubjectType.Attendance, id: attendanceId },
        details: {
          cohortId: row.cohortId,
          instanceId: row.instanceId,
          studentUserId: row.userId,
          from: row.status,
          to: body.status,
          reason,
        },
      });
      return toRowDto(updated, row.windowSeconds);
    });
  }

  private classes(where: SQL | undefined) {
    const counts = this.db
      .select({
        instanceId: attendance.instanceId,
        expected: count().as('expected'),
        present:
          sql<number>`count(*) filter (where ${attendance.status} = ${AttendanceStatus.Present})::int`.as(
            'present',
          ),
        partial:
          sql<number>`count(*) filter (where ${attendance.status} = ${AttendanceStatus.Partial})::int`.as(
            'partial',
          ),
        absent:
          sql<number>`count(*) filter (where ${attendance.status} = ${AttendanceStatus.Absent})::int`.as(
            'absent',
          ),
        seconds: sql<number>`sum(${attendance.presentSeconds})::int`.as(
          'seconds',
        ),
      })
      .from(attendance)
      .groupBy(attendance.instanceId)
      .as('counts');

    return this.db
      .select({
        instanceId: attendanceTallies.instanceId,
        roomLinkId: roomLinks.id,
        cohortId: roomLinks.cohortId,
        title: roomLinks.title,
        audience: roomLinks.audience,
        cohortTrackId: roomLinks.cohortTrackId,
        mentorshipGroupId: roomLinks.mentorshipGroupId,
        startsAt: attendanceTallies.startsAt,
        endsAt: attendanceTallies.endsAt,
        cancelledAt: roomLinkInstances.cancelledAt,
        talliedAt: attendanceTallies.talliedAt,
        windowSeconds,
        expected: sql<number>`coalesce(${counts.expected}, 0)::int`,
        present: sql<number>`coalesce(${counts.present}, 0)`,
        partial: sql<number>`coalesce(${counts.partial}, 0)`,
        absent: sql<number>`coalesce(${counts.absent}, 0)`,
        seconds: sql<number>`coalesce(${counts.seconds}, 0)`,
      })
      .from(attendanceTallies)
      .innerJoin(
        roomLinkInstances,
        eq(roomLinkInstances.id, attendanceTallies.instanceId),
      )
      .innerJoin(roomLinks, eq(roomLinks.id, roomLinkInstances.roomLinkId))
      .leftJoin(counts, eq(counts.instanceId, attendanceTallies.instanceId))
      .where(where)
      .$dynamic();
  }

  /** Admins see the whole cohort; professors their track's classes, mentors their pod's. */
  private async staffScope(
    user: AuthenticatedUser,
    cohortId: string,
    now: Date,
    db: DbExecutor = this.db,
  ): Promise<Scope> {
    if (await this.isAdmin(user, cohortId, db)) {
      return { admin: true };
    }
    const [tracks, groups] = await Promise.all([
      db
        .select({ id: cohortMembers.cohortTrackId })
        .from(cohortMembers)
        .where(
          and(
            eq(cohortMembers.userId, user.id),
            eq(cohortMembers.cohortId, cohortId),
            eq(cohortMembers.role, CohortRole.Professor),
            isLiveMembership(now),
          ),
        ),
      db
        .select({ id: mentorshipGroups.id })
        .from(mentorshipGroups)
        .innerJoin(
          cohortMembers,
          eq(cohortMembers.id, mentorshipGroups.mentorMemberId),
        )
        .where(
          and(
            eq(cohortMembers.userId, user.id),
            eq(mentorshipGroups.cohortId, cohortId),
            isLiveMembership(now),
          ),
        ),
    ]);
    const trackIds = tracks.flatMap((t) => (t.id ? [t.id] : []));
    const groupIds = groups.map((g) => g.id);
    if (trackIds.length === 0 && groupIds.length === 0) {
      throw new AttendanceForbiddenException(
        "Only admins, the cohort's professors on a track and its pods' mentors read attendance",
        { cohortId },
      );
    }
    return { admin: false, trackIds, groupIds };
  }

  /** Throws for a suspended account, and for an admin naming no cohort. */
  private async isAdmin(
    user: AuthenticatedUser,
    cohortId: string,
    db: DbExecutor,
  ): Promise<boolean> {
    const [account] = await db
      .select({ systemRole: users.systemRole, status: users.status })
      .from(users)
      .where(eq(users.id, user.id));
    if (!account || account.status === UserStatus.Suspended) {
      throw new AttendanceForbiddenException(
        'This account may not read attendance',
        { cohortId },
      );
    }
    if (!hasAdminPowers(account.systemRole)) {
      return false;
    }
    const [cohort] = await db
      .select({ id: cohorts.id })
      .from(cohorts)
      .where(eq(cohorts.id, cohortId));
    if (!cohort) {
      throw new CohortNotFoundException(`No cohort with id ${cohortId}`, {
        cohortId,
      });
    }
    return true;
  }
}

const rowFields = {
  id: attendance.id,
  instanceId: attendance.instanceId,
  userId: attendance.userId,
  presentSeconds: attendance.presentSeconds,
  status: attendance.status,
  source: attendance.source,
};

const tallyFields = {
  classes: sql<number>`count(*)::int`,
  present: sql<number>`(count(*) filter (where ${attendance.status} = ${AttendanceStatus.Present}))::int`,
  partial: sql<number>`(count(*) filter (where ${attendance.status} = ${AttendanceStatus.Partial}))::int`,
  absent: sql<number>`(count(*) filter (where ${attendance.status} = ${AttendanceStatus.Absent}))::int`,
  seconds: sql<number>`sum(${attendance.presentSeconds})::int`,
  outOf: sql<number>`sum(extract(epoch from ${attendanceTallies.endsAt} - ${attendanceTallies.startsAt}))::int`,
};

function visible(scope: Scope): SQL | undefined {
  if (scope.admin) {
    return undefined;
  }
  return or(
    scope.trackIds.length > 0
      ? and(
          eq(roomLinks.audience, RoomLinkAudience.CohortTrack),
          inArray(roomLinks.cohortTrackId, scope.trackIds),
        )
      : undefined,
    scope.groupIds.length > 0
      ? and(
          eq(roomLinks.audience, RoomLinkAudience.MentorshipGroup),
          inArray(roomLinks.mentorshipGroupId, scope.groupIds),
        )
      : undefined,
  );
}

function sees(
  scope: Scope,
  link: {
    audience: RoomLinkAudience;
    cohortTrackId: string | null;
    mentorshipGroupId: string | null;
  },
): boolean {
  if (scope.admin) {
    return true;
  }
  if (link.audience === RoomLinkAudience.CohortTrack) {
    return !!link.cohortTrackId && scope.trackIds.includes(link.cohortTrackId);
  }
  if (link.audience === RoomLinkAudience.MentorshipGroup) {
    return (
      !!link.mentorshipGroupId &&
      scope.groupIds.includes(link.mentorshipGroupId)
    );
  }
  return false;
}

function notYours(cohortId: string) {
  return new AttendanceForbiddenException(
    "Whole-cohort classes are for admins; a track's classes for its professors, a pod's for its mentor",
    { cohortId },
  );
}

function toTally(row: {
  classes: number;
  present: number;
  partial: number;
  absent: number;
  seconds: number;
  outOf: number;
}) {
  return {
    classes: row.classes,
    present: row.present,
    partial: row.partial,
    absent: row.absent,
    percentage: percentage(row.seconds, row.outOf),
  };
}

function toRowDto(
  row: {
    id: string;
    userId: string;
    presentSeconds: number;
    status: AttendanceStatus;
    source: AttendanceSource;
  },
  outOf: number,
): AttendanceRowDto {
  return {
    id: row.id,
    userId: row.userId,
    presentSeconds: row.presentSeconds,
    percentage: percentage(row.presentSeconds, outOf),
    status: row.status,
    source: row.source,
  };
}

function toClassDto(row: {
  instanceId: string;
  roomLinkId: string;
  title: string;
  audience: RoomLinkAudience;
  cohortTrackId: string | null;
  mentorshipGroupId: string | null;
  startsAt: Date;
  endsAt: Date;
  cancelledAt: Date | null;
  talliedAt: Date;
  windowSeconds: number;
  expected: number;
  present: number;
  partial: number;
  absent: number;
  seconds: number;
}): AttendanceClassDto {
  return {
    instanceId: row.instanceId,
    roomLinkId: row.roomLinkId,
    title: row.title,
    audience: row.audience,
    cohortTrackId: row.cohortTrackId,
    mentorshipGroupId: row.mentorshipGroupId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    cancelledAt: row.cancelledAt,
    talliedAt: row.talliedAt,
    expected: row.expected,
    present: row.present,
    partial: row.partial,
    absent: row.absent,
    percentage: percentage(row.seconds, row.expected * row.windowSeconds),
  };
}
