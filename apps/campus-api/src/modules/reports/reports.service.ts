import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  gte,
  isNotNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import { toCsv, type CsvColumn } from '../../shared/csv/csv.js';
import { InvalidArgumentException } from '../../shared/exceptions/access.exception.js';
import { writeAuditEntry, type AuditContext } from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType } from '../audit/schema.js';
import { percentage } from '../attendance/attendance.service.js';
import {
  AttendanceSource,
  AttendanceStatus,
  attendance,
  attendanceTallies,
} from '../attendance/schema.js';
import {
  isLiveMembership,
  isNotLiveMembership,
} from '../cohorts/cohort-members.service.js';
import { CohortNotFoundException } from '../cohorts/cohorts.exceptions.js';
import {
  MembershipState,
  RosterScope,
} from '../cohorts/dto/cohort-roster.dto.js';
import {
  CohortRole,
  cohortMembers,
  cohortTracks,
  cohorts,
} from '../cohorts/schema.js';
import { roomLinkInstances, roomLinks } from '../room-links/schema.js';
import { tracks } from '../tracks/schema.js';
import { users } from '../users/schema.js';
import {
  type AttendanceReportDto,
  type AttendanceReportQueryDto,
  type AttendanceReportRowDto,
  type MembershipReportDto,
  type MembershipReportQueryDto,
  type MembershipReportRowDto,
  type ReportCohortDto,
  type ReportMemberDto,
} from './dto/reports.dto.js';

export enum ReportKind {
  Membership = 'membership',
  Attendance = 'attendance',
}

/** A report ready to download. */
export interface CsvReport {
  filename: string;
  body: string;
}

/**
 * A cohort's membership and attendance for admins, whole rather than paged,
 * to read or to download as CSV.
 *
 * The membership report is the roster with the end of each membership: the
 * same live rule, the same track filter, the same order. The attendance
 * report is the per-student summary the attendance reads give, over a range
 * of class starts, with every student the cohort has had, so a student
 * expected at nothing in the range shows as a row of zeros rather than going
 * missing.
 */
@Injectable()
export class ReportsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async membership(
    cohortId: string,
    query: Omit<MembershipReportQueryDto, 'format'>,
    now = new Date(),
  ): Promise<MembershipReportDto> {
    const cohort = await this.cohort(cohortId);
    const rows = await this.db
      .select({
        ...memberFields(now),
        accountStatus: users.status,
        joinedAt: cohortMembers.joinedAt,
        leftAt: cohortMembers.leftAt,
        endReason: cohortMembers.dismissalReason,
        accessExpiresAt: cohortMembers.accessExpiresAt,
      })
      .from(cohortMembers)
      .innerJoin(users, eq(users.id, cohortMembers.userId))
      .leftJoin(cohortTracks, eq(cohortTracks.id, cohortMembers.cohortTrackId))
      .leftJoin(tracks, eq(tracks.id, cohortTracks.trackId))
      .where(
        and(
          eq(cohortMembers.cohortId, cohortId),
          scopeFilter(query.state, now),
          query.role ? eq(cohortMembers.role, query.role) : undefined,
          query.trackId ? eq(cohortTracks.trackId, query.trackId) : undefined,
        ),
      )
      .orderBy(asc(ROLE_ORDER), ...BY_NAME);

    return {
      cohort,
      generatedAt: now,
      rows: rows.map(({ live, ...row }) => ({ ...row, state: stateOf(live) })),
    };
  }

  async attendance(
    cohortId: string,
    query: Omit<AttendanceReportQueryDto, 'format'>,
    now = new Date(),
  ): Promise<AttendanceReportDto> {
    if (query.from && query.to && query.from >= query.to) {
      throw new InvalidArgumentException('`from` must be before `to`', {
        from: query.from,
        to: query.to,
      });
    }
    const cohort = await this.cohort(cohortId);

    const tally = this.db
      .select({
        userId: attendance.userId,
        classes: sql<number>`count(*)::int`.as('classes'),
        present: countWhere(
          sql`${attendance.status} = ${AttendanceStatus.Present}`,
        ).as('present'),
        partial: countWhere(
          sql`${attendance.status} = ${AttendanceStatus.Partial}`,
        ).as('partial'),
        absent: countWhere(
          sql`${attendance.status} = ${AttendanceStatus.Absent}`,
        ).as('absent'),
        corrected: countWhere(
          sql`${attendance.source} = ${AttendanceSource.Override}`,
        ).as('corrected'),
        seconds: sql<number>`sum(${attendance.presentSeconds})::int`.as(
          'seconds',
        ),
        outOf:
          sql<number>`sum(extract(epoch from ${attendanceTallies.endsAt} - ${attendanceTallies.startsAt}))::int`.as(
            'out_of',
          ),
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
          eq(roomLinks.cohortId, cohortId),
          query.from ? gte(attendanceTallies.startsAt, query.from) : undefined,
          query.to ? lt(attendanceTallies.startsAt, query.to) : undefined,
        ),
      )
      .groupBy(attendance.userId)
      .as('tally');

    const rows = await this.db
      .select({
        ...memberFields(now),
        classes: sql<number>`coalesce(${tally.classes}, 0)`,
        present: sql<number>`coalesce(${tally.present}, 0)`,
        partial: sql<number>`coalesce(${tally.partial}, 0)`,
        absent: sql<number>`coalesce(${tally.absent}, 0)`,
        corrected: sql<number>`coalesce(${tally.corrected}, 0)`,
        presentSeconds: sql<number>`coalesce(${tally.seconds}, 0)`,
        possibleSeconds: sql<number>`coalesce(${tally.outOf}, 0)`,
      })
      .from(cohortMembers)
      .innerJoin(users, eq(users.id, cohortMembers.userId))
      .leftJoin(cohortTracks, eq(cohortTracks.id, cohortMembers.cohortTrackId))
      .leftJoin(tracks, eq(tracks.id, cohortTracks.trackId))
      .leftJoin(tally, eq(tally.userId, cohortMembers.userId))
      .where(
        and(
          eq(cohortMembers.cohortId, cohortId),
          // Students, and anybody else with a row: a student since made
          // staff keeps the classes they were expected at as one.
          or(
            eq(cohortMembers.role, CohortRole.Student),
            isNotNull(tally.userId),
          ),
          scopeFilter(query.state, now),
          query.trackId ? eq(cohortTracks.trackId, query.trackId) : undefined,
        ),
      )
      .orderBy(...BY_NAME);

    return {
      cohort,
      generatedAt: now,
      from: query.from ?? null,
      to: query.to ?? null,
      rows: rows.map(({ live, ...row }) => ({
        ...row,
        state: stateOf(live),
        percentage:
          row.classes > 0
            ? percentage(row.presentSeconds, row.possibleSeconds)
            : null,
      })),
    };
  }

  /**
   * The report as CSV, with an `report_exported` audit entry: a download is
   * personal data leaving the campus, so who took which and when is kept.
   */
  async membershipCsv(
    cohortId: string,
    query: Omit<MembershipReportQueryDto, 'format'>,
    audit: AuditContext,
    now = new Date(),
  ): Promise<CsvReport> {
    const report = await this.membership(cohortId, query, now);
    await this.recordExport(ReportKind.Membership, report, query, audit);
    return {
      filename: filename(report.cohort, ReportKind.Membership, now),
      body: toCsv(MEMBERSHIP_COLUMNS, report.rows),
    };
  }

  async attendanceCsv(
    cohortId: string,
    query: Omit<AttendanceReportQueryDto, 'format'>,
    audit: AuditContext,
    now = new Date(),
  ): Promise<CsvReport> {
    const report = await this.attendance(cohortId, query, now);
    await this.recordExport(ReportKind.Attendance, report, query, audit);
    return {
      filename: filename(report.cohort, ReportKind.Attendance, now),
      body: toCsv(ATTENDANCE_COLUMNS, report.rows),
    };
  }

  private async recordExport(
    report: ReportKind,
    { cohort, rows }: { cohort: ReportCohortDto; rows: unknown[] },
    query: {
      state: RosterScope;
      trackId?: string;
      role?: CohortRole;
      from?: Date;
      to?: Date;
    },
    audit: AuditContext,
  ): Promise<void> {
    await writeAuditEntry(this.db, {
      ...audit,
      action: AuditAction.ReportExported,
      subject: { type: AuditSubjectType.Cohort, id: cohort.id },
      details: {
        report,
        state: query.state,
        trackId: query.trackId ?? null,
        role: query.role ?? null,
        from: query.from?.toISOString() ?? null,
        to: query.to?.toISOString() ?? null,
        rows: rows.length,
      },
    });
  }

  private async cohort(cohortId: string): Promise<ReportCohortDto> {
    const [cohort] = await this.db
      .select({ id: cohorts.id, code: cohorts.code, name: cohorts.name })
      .from(cohorts)
      .where(eq(cohorts.id, cohortId));
    if (!cohort) {
      throw new CohortNotFoundException(`Cohort ${cohortId} not found`, {
        cohortId,
      });
    }
    return cohort;
  }
}

function memberFields(now: Date) {
  return {
    membershipId: cohortMembers.id,
    userId: users.id,
    email: users.email,
    firstName: users.firstName,
    lastName: users.lastName,
    displayName: users.displayName,
    role: cohortMembers.role,
    trackCode: tracks.code,
    trackName: tracks.name,
    studentStatus: cohortMembers.status,
    live: sql<boolean>`${isLiveMembership(now)}`,
  };
}

function countWhere(condition: SQL) {
  return sql<number>`(count(*) filter (where ${condition}))::int`;
}

function stateOf(live: boolean): MembershipState {
  return live ? MembershipState.Live : MembershipState.Ended;
}

function scopeFilter(scope: RosterScope, now: Date): SQL | undefined {
  switch (scope) {
    case RosterScope.Live:
      return isLiveMembership(now);
    case RosterScope.Ended:
      return isNotLiveMembership(now);
    case RosterScope.All:
      return undefined;
  }
}

/** The roster's order: staff as one group, then students, then guests. */
const ROLE_ORDER = sql`case ${cohortMembers.role}
  when ${sql.raw(`'${CohortRole.Professor}'`)} then 0
  when ${sql.raw(`'${CohortRole.Mentor}'`)} then 0
  when ${sql.raw(`'${CohortRole.Student}'`)} then 1
  else 2 end`;

const BY_NAME = [
  asc(sql`lower(coalesce(${users.lastName}, ''))`),
  asc(sql`lower(coalesce(${users.firstName}, ''))`),
  asc(users.email),
  asc(cohortMembers.id),
];

/** `C1-attendance-2026-11-22.csv`: the code, kept to characters every OS allows. */
function filename(cohort: ReportCohortDto, report: ReportKind, now: Date) {
  const code = cohort.code.replace(/[^A-Za-z0-9_-]/g, '') || 'cohort';
  return `${code}-${report}-${now.toISOString().slice(0, 10)}.csv`;
}

const MEMBER_COLUMNS: CsvColumn<ReportMemberDto>[] = [
  { header: 'email', value: (r) => r.email },
  { header: 'first_name', value: (r) => r.firstName },
  { header: 'last_name', value: (r) => r.lastName },
  { header: 'display_name', value: (r) => r.displayName },
  { header: 'role', value: (r) => r.role },
  { header: 'track_code', value: (r) => r.trackCode },
  { header: 'track_name', value: (r) => r.trackName },
  { header: 'student_status', value: (r) => r.studentStatus },
  { header: 'state', value: (r) => r.state },
];

const MEMBERSHIP_COLUMNS: CsvColumn<MembershipReportRowDto>[] = [
  ...MEMBER_COLUMNS,
  { header: 'account_status', value: (r) => r.accountStatus },
  { header: 'joined_at', value: (r) => r.joinedAt },
  { header: 'left_at', value: (r) => r.leftAt },
  { header: 'end_reason', value: (r) => r.endReason },
  { header: 'access_expires_at', value: (r) => r.accessExpiresAt },
  { header: 'user_id', value: (r) => r.userId },
  { header: 'membership_id', value: (r) => r.membershipId },
];

const ATTENDANCE_COLUMNS: CsvColumn<AttendanceReportRowDto>[] = [
  ...MEMBER_COLUMNS,
  { header: 'classes', value: (r) => r.classes },
  { header: 'present', value: (r) => r.present },
  { header: 'partial', value: (r) => r.partial },
  { header: 'absent', value: (r) => r.absent },
  { header: 'corrected', value: (r) => r.corrected },
  { header: 'present_seconds', value: (r) => r.presentSeconds },
  { header: 'possible_seconds', value: (r) => r.possibleSeconds },
  { header: 'percentage', value: (r) => r.percentage },
  { header: 'user_id', value: (r) => r.userId },
  { header: 'membership_id', value: (r) => r.membershipId },
];
