import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import { timestamptz } from '../../infra/database/timestamptz.js';
import { Scheduler } from '../../infra/scheduler/scheduler.js';
import { CohortRole, cohortMembers } from '../cohorts/schema.js';
import { mentorshipGroupStudents } from '../mentorship-groups/schema.js';
import {
  RoomLinkAudience,
  roomLinkInstances,
  roomLinks,
} from '../room-links/schema.js';
import {
  AttendanceSource,
  AttendanceStatus,
  attendance,
  attendanceTallies,
} from './schema.js';

export const TALLY_JOB_MS = 5 * 60_000;
/** Late webhooks from LiveKit have arrived by then. */
export const TALLY_DELAY_MS = 5 * 60_000;
export const PRESENT_SHARE = 0.75;
const RUNS_PER_TALLY = 100;

interface DueRun {
  instanceId: string;
  startsAt: Date;
  endsAt: Date;
  cohortId: string;
  spaceId: string;
  audience: string;
  cohortTrackId: string | null;
  mentorshipGroupId: string | null;
}

export function attendanceStatus(
  presentSeconds: number,
  windowSeconds: number,
): AttendanceStatus {
  if (presentSeconds >= PRESENT_SHARE * windowSeconds) {
    return AttendanceStatus.Present;
  }
  return presentSeconds > 0
    ? AttendanceStatus.Partial
    : AttendanceStatus.Absent;
}

/**
 * Works out attendance for runs that have ended: every student expected at
 * the run, and their time in the space's call inside it. A run moved after
 * it was tallied is tallied again; one cancelled loses its derived rows.
 * Corrections by staff keep their status throughout.
 */
@Injectable()
export class AttendanceTallyService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly scheduler: Scheduler,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AttendanceTallyService.name);
  }

  onModuleInit(): void {
    this.scheduler.register({
      name: 'attendance-tally',
      everyMs: TALLY_JOB_MS,
      run: (now) => this.tallyDue(now),
    });
  }

  async tallyDue(now: Date): Promise<void> {
    await this.voidCancelled();
    const due = await this.db
      .select({
        instanceId: roomLinkInstances.id,
        startsAt: roomLinkInstances.startsAt,
        endsAt: roomLinkInstances.endsAt,
        cohortId: roomLinks.cohortId,
        spaceId: roomLinks.spaceId,
        audience: roomLinks.audience,
        cohortTrackId: roomLinks.cohortTrackId,
        mentorshipGroupId: roomLinks.mentorshipGroupId,
      })
      .from(roomLinkInstances)
      .innerJoin(roomLinks, eq(roomLinks.id, roomLinkInstances.roomLinkId))
      .leftJoin(
        attendanceTallies,
        eq(attendanceTallies.instanceId, roomLinkInstances.id),
      )
      .where(
        and(
          isNull(roomLinkInstances.cancelledAt),
          lte(
            roomLinkInstances.endsAt,
            new Date(now.getTime() - TALLY_DELAY_MS),
          ),
          or(
            isNull(attendanceTallies.instanceId),
            ne(attendanceTallies.startsAt, roomLinkInstances.startsAt),
            ne(attendanceTallies.endsAt, roomLinkInstances.endsAt),
          ),
        ),
      )
      .orderBy(asc(roomLinkInstances.endsAt))
      .limit(RUNS_PER_TALLY);
    for (const run of due) {
      try {
        await this.tally(run, now);
      } catch (err) {
        this.logger.error(
          { err, instanceId: run.instanceId },
          'attendance tally failed',
        );
      }
    }
  }

  private async tally(run: DueRun, now: Date): Promise<void> {
    const windowSeconds = Math.floor(
      (run.endsAt.getTime() - run.startsAt.getTime()) / 1000,
    );
    const start = timestamptz(run.startsAt);
    const end = timestamptz(run.endsAt);
    const until = timestamptz(now);
    // cohort_members.user_id is spelt out: drizzle leaves a select list's
    // columns unqualified, which here would name the call's own user_id. The
    // sum is coalesced first because least() ignores a null.
    const presentSeconds = sql<number>`coalesce((
      select floor(least(coalesce(sum(extract(epoch from (
        least(coalesce(sp.left_at, s.closed_at, ${until}), ${end})
        - greatest(sp.joined_at, ${start})
      ))), 0), ${windowSeconds}))::int
      from session_participants sp
      join sessions s on s.id = sp.session_id
      where sp.user_id = cohort_members.user_id
        and s.cohort_id = ${run.cohortId}
        and s.space_id = ${run.spaceId}
        and sp.joined_at < ${end}
        and coalesce(sp.left_at, s.closed_at, ${until}) > ${start}
    ), 0)`.mapWith(Number);

    const expected = await this.db
      .select({ userId: cohortMembers.userId, presentSeconds })
      .from(cohortMembers)
      .where(
        and(
          eq(cohortMembers.cohortId, run.cohortId),
          eq(cohortMembers.role, CohortRole.Student),
          lte(cohortMembers.joinedAt, run.startsAt),
          or(
            isNull(cohortMembers.leftAt),
            gt(cohortMembers.leftAt, run.startsAt),
          ),
          this.inAudience(run),
        ),
      );

    await this.db.transaction(async (tx) => {
      await tx
        .insert(attendanceTallies)
        .values({
          instanceId: run.instanceId,
          startsAt: run.startsAt,
          endsAt: run.endsAt,
          talliedAt: now,
        })
        .onConflictDoUpdate({
          target: attendanceTallies.instanceId,
          set: { startsAt: run.startsAt, endsAt: run.endsAt, talliedAt: now },
        });
      const ids = expected.map((e) => e.userId);
      await tx
        .delete(attendance)
        .where(
          and(
            eq(attendance.instanceId, run.instanceId),
            eq(attendance.source, AttendanceSource.Derived),
            ids.length > 0 ? notInArray(attendance.userId, ids) : undefined,
          ),
        );
      if (expected.length === 0) {
        return;
      }
      await tx
        .insert(attendance)
        .values(
          expected.map((e) => ({
            instanceId: run.instanceId,
            userId: e.userId,
            presentSeconds: e.presentSeconds,
            status: attendanceStatus(e.presentSeconds, windowSeconds),
          })),
        )
        .onConflictDoUpdate({
          target: [attendance.instanceId, attendance.userId],
          set: {
            presentSeconds: sql`excluded.present_seconds`,
            status: sql`case when ${attendance.source} = ${AttendanceSource.Derived} then excluded.status else ${attendance.status} end`,
            updatedAt: now,
          },
        });
    });
  }

  private inAudience(run: DueRun): SQL | undefined {
    switch (run.audience) {
      case RoomLinkAudience.CohortTrack:
        return run.cohortTrackId
          ? eq(cohortMembers.cohortTrackId, run.cohortTrackId)
          : sql`false`;
      case RoomLinkAudience.MentorshipGroup:
        return run.mentorshipGroupId
          ? exists(
              this.db
                .select({ one: sql`1` })
                .from(mentorshipGroupStudents)
                .where(
                  and(
                    eq(
                      mentorshipGroupStudents.cohortMemberId,
                      cohortMembers.id,
                    ),
                    eq(
                      mentorshipGroupStudents.mentorshipGroupId,
                      run.mentorshipGroupId,
                    ),
                  ),
                ),
            )
          : sql`false`;
      default:
        return undefined;
    }
  }

  /** A run cancelled after its tally no longer counts; corrections stay. */
  private async voidCancelled(): Promise<void> {
    const voided = await this.db
      .delete(attendance)
      .where(
        and(
          eq(attendance.source, AttendanceSource.Derived),
          inArray(
            attendance.instanceId,
            this.db
              .select({ id: roomLinkInstances.id })
              .from(roomLinkInstances)
              .where(isNotNull(roomLinkInstances.cancelledAt)),
          ),
        ),
      )
      .returning({ id: attendance.id });
    if (voided.length > 0) {
      this.logger.info(
        { count: voided.length },
        'attendance voided: runs cancelled after their tally',
      );
    }
  }
}
