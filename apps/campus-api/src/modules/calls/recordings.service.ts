import { randomUUID } from 'node:crypto';

import {
  RecordingRefusedError,
  parseSpaceRoomName,
  spaceRoomName,
  type RecordingEvent,
  type StartedRecording,
} from '@campus/media';
import { COHORT_ROLES, SPACE_ACCESS, mayEnter } from '@campus/space-access';
import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';

import {
  DRIZZLE,
  type Db,
  type DbExecutor,
} from '../../infra/database/database.constants.js';
import { timestamptz } from '../../infra/database/timestamptz.js';
import { isUniqueViolation } from '../../infra/database/unique-violation.js';
import { hasAdminPowers } from '../users/schema.js';
import {
  RecordingConflictException,
  RecordingForbiddenException,
  RecordingNotConfiguredException,
  RecordingNotFoundException,
  RecordingUnavailableException,
} from './calls.exceptions.js';
import { RECORDING_MEDIA, type RecordingMedia } from './recording-media.js';
import {
  RecordingStatus,
  recordings,
  sessions,
  type CallRecording,
} from './schema.js';
import { personFacts, spaceFacts } from './space-access-facts.js';

const LIVE = [RecordingStatus.Starting, RecordingStatus.Active];
const OVER = [RecordingStatus.Complete, RecordingStatus.Failed];

/**
 * How long a start LiveKit did not answer is left to its webhooks before
 * LiveKit is asked about it: well past the client's 10 s timeout.
 */
export const START_SETTLE_MS = 2 * 60_000;

interface LiveRecording {
  recording: CallRecording;
  /** Its session has closed: the run it was started in is over. */
  closed: boolean;
}

const STAFF_ROLES: readonly string[] = [
  COHORT_ROLES.Professor,
  COHORT_ROLES.Mentor,
];

/**
 * Recordings of a space's call. Staff start and stop them; LiveKit records
 * the whole room into the bucket and tells the webhook how it went. Everyone
 * in the call learns a recording is on from LiveKit itself, through the
 * room's recording flag.
 */
@Injectable()
export class RecordingsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(RECORDING_MEDIA) private readonly media: RecordingMedia | null,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RecordingsService.name);
  }

  async start(
    userId: string,
    cohortId: string,
    spaceId: string,
    now: Date,
  ): Promise<CallRecording> {
    await this.requireStaff(userId, cohortId, spaceId, now);
    const media = this.requireMedia();
    const session = await this.openSession(cohortId, spaceId);
    if (!session) {
      throw new RecordingConflictException(
        'There is no call in this space to record',
        { cohortId, spaceId },
      );
    }

    await this.settle(media, cohortId, spaceId, now);

    const room = spaceRoomName({ cohortId, spaceId });
    const id = randomUUID();
    let row: CallRecording;
    try {
      row = await this.db.transaction(async (tx) => {
        // One start in a space at a time, whichever run of its call each saw.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${room}))`);
        if ((await this.live(tx, cohortId, spaceId)).length > 0) {
          throw new RecordingConflictException(
            'This call is already being recorded',
            { cohortId, spaceId },
          );
        }
        const [inserted] = await tx
          .insert(recordings)
          .values({
            id,
            sessionId: session.id,
            startedBy: userId,
            fileKey: `cohorts/${cohortId}/spaces/${spaceId}/${id}.mp4`,
            requestedAt: now,
          })
          .returning();
        return inserted;
      });
    } catch (err) {
      if (isUniqueViolation(err, 'recordings_one_live_per_session')) {
        throw new RecordingConflictException(
          'This call is already being recorded',
          { cohortId, spaceId },
        );
      }
      throw err;
    }

    let started: StartedRecording;
    try {
      started = await media.start(room, row.fileKey);
    } catch (err) {
      if (err instanceof RecordingRefusedError) {
        this.logger.warn(
          { err, recordingId: id, cohortId, spaceId },
          'LiveKit would not start a recording',
        );
        await this.db
          .update(recordings)
          .set({
            status: RecordingStatus.Failed,
            error: err.message,
            endedAt: now,
          })
          .where(
            and(
              eq(recordings.id, id),
              eq(recordings.status, RecordingStatus.Starting),
            ),
          );
        throw new RecordingUnavailableException(
          'The recording could not be started',
          { cohortId, spaceId },
        );
      }
      // LiveKit may have started it: the row stays starting, for its
      // webhooks or a later settle to say how it went.
      this.logger.warn(
        { err, recordingId: id, cohortId, spaceId },
        'no answer from LiveKit to a recording start',
      );
      const found = await this.find(media, row);
      if (found) {
        await this.record(found, now);
        return this.byId(id);
      }
      throw new RecordingUnavailableException(
        'LiveKit did not answer; the recording may have started. Try again in a few minutes',
        { cohortId, spaceId },
      );
    }

    // The webhook may have filled it in already, from the file key.
    await this.db
      .update(recordings)
      .set({ providerEgressId: started.egressId })
      .where(eq(recordings.id, id));
    if (started.roomId) await this.follow(this.db, id, started.roomId);
    return this.byId(id);
  }

  async stop(
    userId: string,
    cohortId: string,
    spaceId: string,
    now: Date,
  ): Promise<CallRecording> {
    await this.requireStaff(userId, cohortId, spaceId, now);
    const media = this.requireMedia();

    await this.settle(media, cohortId, spaceId, now);

    // Whichever run it records: one started as the call turned over may
    // belong to a session that has since closed.
    const live = await this.live(this.db, cohortId, spaceId);
    if (live.length === 0) {
      throw new RecordingNotFoundException(
        'Nothing is being recorded in this space',
        { cohortId, spaceId },
      );
    }
    const going = live.filter(({ recording }) => recording.providerEgressId);
    if (going.length === 0) {
      throw new RecordingConflictException(
        'The recording is still starting; try again in a moment',
        { cohortId, spaceId },
      );
    }

    let stopped!: CallRecording;
    for (const { recording } of going) {
      await media.stop(recording.providerEgressId!);
      [stopped] = await this.db
        .update(recordings)
        .set({
          stoppedBy: sql`coalesce(${recordings.stoppedBy}, ${userId}::uuid)`,
        })
        .where(eq(recordings.id, recording.id))
        .returning();
    }
    return stopped;
  }

  /** Applies what LiveKit says of a recording. A finished one stays finished. */
  async record(event: RecordingEvent, at: Date): Promise<void> {
    if (!parseSpaceRoomName(event.room)) return;
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(recordings)
        .where(
          or(
            eq(recordings.providerEgressId, event.egressId),
            event.fileKey ? eq(recordings.fileKey, event.fileKey) : sql`false`,
          ),
        )
        .for('update');
      if (!row) {
        this.logger.warn(
          { egressId: event.egressId, room: event.room },
          'a recording nothing here started',
        );
        return;
      }
      if (event.roomId) await this.follow(tx, row.id, event.roomId);
      if (OVER.includes(row.status) || !event.state) {
        if (!row.providerEgressId) {
          await tx
            .update(recordings)
            .set({ providerEgressId: event.egressId })
            .where(eq(recordings.id, row.id));
        }
        return;
      }

      const startedAt = row.startedAt ?? event.startedAt ?? at;
      const status =
        event.state === 'active'
          ? RecordingStatus.Active
          : event.state === 'complete'
            ? RecordingStatus.Complete
            : RecordingStatus.Failed;
      const ended = status !== RecordingStatus.Active;
      const endedAt = ended ? (event.endedAt ?? at) : null;
      await tx
        .update(recordings)
        .set({
          providerEgressId: event.egressId,
          status,
          startedAt,
          endedAt: endedAt && endedAt < startedAt ? startedAt : endedAt,
          durationMs: event.durationMs,
          sizeBytes: event.sizeBytes,
          error: event.error,
        })
        .where(eq(recordings.id, row.id));
    });
  }

  /**
   * Live recordings of the space, in any run of its call, oldest first. A
   * call that turned over as a recording started may leave one attached to
   * the run before, until LiveKit says which run it records.
   */
  private async live(
    executor: DbExecutor,
    cohortId: string,
    spaceId: string,
  ): Promise<LiveRecording[]> {
    return executor
      .select({
        recording: recordings,
        closed: sql<boolean>`${sessions.closedAt} is not null`,
      })
      .from(recordings)
      .innerJoin(sessions, eq(sessions.id, recordings.sessionId))
      .where(
        and(
          eq(sessions.cohortId, cohortId),
          eq(sessions.spaceId, spaceId),
          inArray(recordings.status, LIVE),
        ),
      )
      .orderBy(asc(recordings.requestedAt));
  }

  /**
   * Asks LiveKit about the live recordings of the space nothing here can
   * vouch for: a start it did not answer, once its webhooks have had time
   * to arrive, and a recording whose run has closed. What LiveKit says is
   * applied as its webhook would be; one it has no record of failed.
   */
  private async settle(
    media: RecordingMedia,
    cohortId: string,
    spaceId: string,
    now: Date,
  ): Promise<void> {
    const doubtful = (await this.live(this.db, cohortId, spaceId)).filter(
      ({ recording, closed }) =>
        closed ||
        (!recording.providerEgressId &&
          now.getTime() - recording.requestedAt.getTime() >= START_SETTLE_MS),
    );
    for (const { recording } of doubtful) {
      const found = await this.find(media, recording);
      if (found === undefined) continue;
      if (found) {
        await this.record(found, now);
        continue;
      }
      await this.db
        .update(recordings)
        .set({
          status: RecordingStatus.Failed,
          error: 'LiveKit has no record of it',
          endedAt: sql`greatest(${timestamptz(now)}, ${recordings.startedAt})`,
        })
        .where(
          and(
            eq(recordings.id, recording.id),
            inArray(recordings.status, LIVE),
          ),
        );
    }
  }

  /** What LiveKit knows of a recording; undefined if it could not be asked. */
  private async find(
    media: RecordingMedia,
    recording: CallRecording,
  ): Promise<RecordingEvent | null | undefined> {
    const room = await this.roomOf(recording.sessionId);
    try {
      return await media.find(room, recording.fileKey);
    } catch (err) {
      this.logger.warn(
        { err, recordingId: recording.id },
        'could not ask LiveKit about a recording',
      );
      return undefined;
    }
  }

  private async roomOf(sessionId: string): Promise<string> {
    const [session] = await this.db
      .select({ cohortId: sessions.cohortId, spaceId: sessions.spaceId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    return spaceRoomName(session);
  }

  /**
   * Attaches a recording to the session of the run LiveKit says it records,
   * once that run is known here. A live one stays put if that session has
   * a live recording already.
   */
  private async follow(
    executor: DbExecutor,
    id: string,
    roomId: string,
  ): Promise<void> {
    const [run] = await executor
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.providerRoomId, roomId));
    if (!run) return;
    await executor
      .update(recordings)
      .set({ sessionId: run.id })
      .where(
        and(
          eq(recordings.id, id),
          ne(recordings.sessionId, run.id),
          or(
            notInArray(recordings.status, LIVE),
            sql`not exists (select 1 from recordings other where other.session_id = ${run.id} and other.status in ('starting', 'active') and other.id <> ${id})`,
          ),
        ),
      );
  }

  private async byId(id: string): Promise<CallRecording> {
    const [row] = await this.db
      .select()
      .from(recordings)
      .where(eq(recordings.id, id));
    return row;
  }

  private requireMedia(): RecordingMedia {
    if (!this.media) {
      throw new RecordingNotConfiguredException(
        'Recording is not configured here',
      );
    }
    return this.media;
  }

  /**
   * As for muting and removing: admins in any space of the cohort's campus;
   * the cohort's professors and mentors only in a designated space whose
   * list names them.
   */
  private async requireStaff(
    userId: string,
    cohortId: string,
    spaceId: string,
    now: Date,
    db: DbExecutor = this.db,
  ): Promise<void> {
    const [person, space] = await Promise.all([
      personFacts(db, userId, cohortId),
      spaceFacts(db, spaceId),
    ]);
    if (!space) {
      throw new RecordingNotFoundException('No space with that id', {
        spaceId,
      });
    }
    const staff =
      person !== null &&
      (hasAdminPowers(person.systemRole) ||
        (person.membership !== null &&
          STAFF_ROLES.includes(person.membership.role) &&
          space.access === SPACE_ACCESS.Designated)) &&
      mayEnter(person, space, now);
    if (!staff) {
      throw new RecordingForbiddenException(
        "Only admins, and the cohort's professors and mentors in a designated space whose list names them, record its call",
        { cohortId, spaceId },
      );
    }
  }

  private async openSession(
    cohortId: string,
    spaceId: string,
  ): Promise<{ id: string } | undefined> {
    const [session] = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.cohortId, cohortId),
          eq(sessions.spaceId, spaceId),
          isNull(sessions.closedAt),
        ),
      );
    return session;
  }
}
