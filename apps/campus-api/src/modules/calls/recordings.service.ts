import { randomUUID } from 'node:crypto';

import {
  parseSpaceRoomName,
  spaceRoomName,
  type RecordingEvent,
} from '@campus/media';
import { COHORT_ROLES, SPACE_ACCESS, mayEnter } from '@campus/space-access';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';

import {
  DRIZZLE,
  type Db,
  type DbExecutor,
} from '../../infra/database/database.constants.js';
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

    const id = randomUUID();
    let row: CallRecording;
    try {
      [row] = await this.db
        .insert(recordings)
        .values({
          id,
          sessionId: session.id,
          startedBy: userId,
          fileKey: `cohorts/${cohortId}/spaces/${spaceId}/${id}.mp4`,
          requestedAt: now,
        })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err, 'recordings_one_live_per_session')) {
        throw new RecordingConflictException(
          'This call is already being recorded',
          { cohortId, spaceId },
        );
      }
      throw err;
    }

    let egressId: string;
    try {
      egressId = await media.start(
        spaceRoomName({ cohortId, spaceId }),
        row.fileKey,
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(
        { err, recordingId: id, cohortId, spaceId },
        'LiveKit would not start a recording',
      );
      await this.db
        .update(recordings)
        .set({ status: RecordingStatus.Failed, error: message, endedAt: now })
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

    // The webhook may have filled it in already, from the file key.
    const [updated] = await this.db
      .update(recordings)
      .set({ providerEgressId: egressId })
      .where(eq(recordings.id, id))
      .returning();
    return updated;
  }

  async stop(
    userId: string,
    cohortId: string,
    spaceId: string,
    now: Date,
  ): Promise<CallRecording> {
    await this.requireStaff(userId, cohortId, spaceId, now);
    const media = this.requireMedia();

    const [live] = await this.db
      .select({ recording: recordings })
      .from(recordings)
      .innerJoin(sessions, eq(sessions.id, recordings.sessionId))
      .where(
        and(
          eq(sessions.cohortId, cohortId),
          eq(sessions.spaceId, spaceId),
          isNull(sessions.closedAt),
          inArray(recordings.status, LIVE),
        ),
      );
    if (!live) {
      throw new RecordingNotFoundException(
        'Nothing is being recorded in this space',
        { cohortId, spaceId },
      );
    }
    const egressId = live.recording.providerEgressId;
    if (!egressId) {
      throw new RecordingConflictException(
        'The recording is still starting; try again in a moment',
        { cohortId, spaceId },
      );
    }

    await media.stop(egressId);
    const [stopped] = await this.db
      .update(recordings)
      .set({
        stoppedBy: sql`coalesce(${recordings.stoppedBy}, ${userId}::uuid)`,
      })
      .where(eq(recordings.id, live.recording.id))
      .returning();
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
