import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import { timestamptz } from '../../infra/database/timestamptz.js';
import { Scheduler } from '../../infra/scheduler/scheduler.js';
import { sessionParticipants, sessions } from '../calls/schema.js';
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
  cancelledAt: Date | null;
  cohortId: string;
  spaceId: string;
  audience: RoomLinkAudience;
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

/** Milliseconds covered by these stretches, overlaps counted once. */
export function coveredMs(stretches: { from: Date; to: Date }[]): number {
  const sorted = stretches
    .map((s) => [s.from.getTime(), s.to.getTime()] as const)
    .filter(([from, to]) => to > from)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let open: [number, number] | null = null;
  for (const [from, to] of sorted) {
    if (open && from <= open[1]) {
      open[1] = Math.max(open[1], to);
      continue;
    }
    if (open) {
      total += open[1] - open[0];
    }
    open = [from, to];
  }
  return open ? total + open[1] - open[0] : total;
}

/**
 * Works out attendance for runs that have ended: every student expected at
 * the run, and their time in the space's call inside it. A run is tallied
 * again whenever it changed after its last tally (moved, cancelled,
 * restored, or bound to another link); a cancelled one loses its derived
 * rows. Corrections by staff keep their status throughout.
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
    const due = await this.db
      .select({
        instanceId: roomLinkInstances.id,
        startsAt: roomLinkInstances.startsAt,
        endsAt: roomLinkInstances.endsAt,
        cancelledAt: roomLinkInstances.cancelledAt,
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
          lte(
            roomLinkInstances.endsAt,
            new Date(now.getTime() - TALLY_DELAY_MS),
          ),
          or(
            and(
              isNull(attendanceTallies.instanceId),
              isNull(roomLinkInstances.cancelledAt),
            ),
            lt(attendanceTallies.talliedAt, roomLinkInstances.updatedAt),
          ),
        ),
      )
      .orderBy(asc(roomLinkInstances.endsAt))
      .limit(RUNS_PER_TALLY);
    for (const run of due) {
      try {
        await (run.cancelledAt ? this.void(run, now) : this.tally(run, now));
      } catch (err) {
        this.logger.error(
          { err, instanceId: run.instanceId },
          'attendance tally failed',
        );
      }
    }
  }

  private async tally(run: DueRun, now: Date): Promise<void> {
    const windowMs = run.endsAt.getTime() - run.startsAt.getTime();
    const expected = await this.expected(run);
    const time = await this.timeInCall(run, expected, now);

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
      await tx
        .delete(attendance)
        .where(
          and(
            eq(attendance.instanceId, run.instanceId),
            eq(attendance.source, AttendanceSource.Derived),
            expected.length > 0
              ? notInArray(attendance.userId, expected)
              : undefined,
          ),
        );
      if (expected.length === 0) {
        return;
      }
      await tx
        .insert(attendance)
        .values(
          expected.map((userId) => {
            const presentSeconds = Math.floor(
              Math.min(time.get(userId) ?? 0, windowMs) / 1000,
            );
            return {
              instanceId: run.instanceId,
              userId,
              presentSeconds,
              status: attendanceStatus(presentSeconds, windowMs / 1000),
            };
          }),
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

  /**
   * The students expected at the run. When the link's track or pod has gone
   * since (detached or deleted after the link was revoked), whoever the last
   * tally expected stays expected, so a re-tally cannot erase them.
   */
  private async expected(run: DueRun): Promise<string[]> {
    const lost =
      (run.audience === RoomLinkAudience.CohortTrack && !run.cohortTrackId) ||
      (run.audience === RoomLinkAudience.MentorshipGroup &&
        !run.mentorshipGroupId);
    if (lost) {
      const rows = await this.db
        .select({ userId: attendance.userId })
        .from(attendance)
        .where(eq(attendance.instanceId, run.instanceId));
      return rows.map((r) => r.userId);
    }
    const rows = await this.db
      .select({ userId: cohortMembers.userId })
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
    return rows.map((r) => r.userId);
  }

  /** Each student's time in the cohort's call in the space, inside the run. */
  private async timeInCall(
    run: DueRun,
    userIds: string[],
    now: Date,
  ): Promise<Map<string, number>> {
    if (userIds.length === 0) {
      return new Map();
    }
    const until = sql`coalesce(${sessionParticipants.leftAt}, ${sessions.closedAt}, ${timestamptz(now)})`;
    const stretches = await this.db
      .select({
        userId: sessionParticipants.userId,
        from: sql<Date>`greatest(${sessionParticipants.joinedAt}, ${timestamptz(run.startsAt)})`.mapWith(
          (v: string | Date) => new Date(v),
        ),
        to: sql<Date>`least(${until}, ${timestamptz(run.endsAt)})`.mapWith(
          (v: string | Date) => new Date(v),
        ),
      })
      .from(sessionParticipants)
      .innerJoin(sessions, eq(sessions.id, sessionParticipants.sessionId))
      .where(
        and(
          inArray(sessionParticipants.userId, userIds),
          eq(sessions.cohortId, run.cohortId),
          eq(sessions.spaceId, run.spaceId),
          lt(sessionParticipants.joinedAt, run.endsAt),
          sql`${until} > ${timestamptz(run.startsAt)}`,
        ),
      );
    const byUser = new Map<string, { from: Date; to: Date }[]>();
    for (const s of stretches) {
      byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), s]);
    }
    return new Map(
      [...byUser].map(([userId, list]) => [userId, coveredMs(list)]),
    );
  }

  private inAudience(run: DueRun): SQL | undefined {
    switch (run.audience) {
      case RoomLinkAudience.CohortTrack:
        return eq(cohortMembers.cohortTrackId, run.cohortTrackId!);
      case RoomLinkAudience.MentorshipGroup:
        return exists(
          this.db
            .select({ one: sql`1` })
            .from(mentorshipGroupStudents)
            .where(
              and(
                eq(mentorshipGroupStudents.cohortMemberId, cohortMembers.id),
                eq(
                  mentorshipGroupStudents.mentorshipGroupId,
                  run.mentorshipGroupId!,
                ),
              ),
            ),
        );
      default:
        return undefined;
    }
  }

  /** A run cancelled after its tally no longer counts; corrections stay. */
  private async void(run: DueRun, now: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(attendance)
        .where(
          and(
            eq(attendance.instanceId, run.instanceId),
            eq(attendance.source, AttendanceSource.Derived),
          ),
        );
      await tx
        .update(attendanceTallies)
        .set({ talliedAt: now })
        .where(eq(attendanceTallies.instanceId, run.instanceId));
    });
    this.logger.info(
      { instanceId: run.instanceId },
      'attendance voided: run cancelled after its tally',
    );
  }
}
