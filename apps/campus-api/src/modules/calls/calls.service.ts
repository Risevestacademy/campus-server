import {
  parseSpaceRoomName,
  userIdOfIdentity,
  type CallEvent,
  type SpaceRoom,
} from '@campus/media';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';

import {
  DRIZZLE,
  type Db,
  type Tx,
} from '../../infra/database/database.constants.js';
import { isForeignKeyViolation } from '../../infra/database/foreign-key-violation.js';
import { sessionParticipants, sessions } from './schema.js';

/**
 * Writes what LiveKit says happened in a space's call. A session is one run
 * of a room, keyed by LiveKit's id for that run. LiveKit retries what it
 * could not deliver and does not promise order, so every event checks what
 * is already recorded: a repeat changes nothing, and an event from a run that
 * has since been replaced is dropped.
 */
@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async record(event: CallEvent, at: Date): Promise<void> {
    const room = parseSpaceRoomName(event.room);
    if (!room) return;
    try {
      await this.db.transaction((tx) => this.apply(tx, event, room, at));
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        this.logger.warn(`call event for something gone: ${event.room}`);
        return;
      }
      throw err;
    }
  }

  private async apply(
    tx: Tx,
    event: CallEvent,
    room: SpaceRoom,
    at: Date,
  ): Promise<void> {
    const run = await this.sessionFor(tx, room, event.roomId, at);
    if (!run) return;
    const sessionId = run.id;
    const stamp = sql`${at.toISOString()}::timestamptz`;

    switch (event.kind) {
      case 'room_started':
        return;
      case 'room_finished': {
        await tx
          .update(sessions)
          .set({ closedAt: sql`greatest(${stamp}, ${sessions.openedAt})` })
          .where(and(eq(sessions.id, sessionId), isNull(sessions.closedAt)));
        await tx
          .update(sessionParticipants)
          .set({
            leftAt: sql`greatest(${stamp}, ${sessionParticipants.joinedAt})`,
          })
          .where(
            and(
              eq(sessionParticipants.sessionId, sessionId),
              isNull(sessionParticipants.leftAt),
            ),
          );
        return;
      }
      case 'participant_joined': {
        const userId = userIdOfIdentity(event.identity);
        if (!userId || run.closed) return;
        const [seen] = await tx
          .select({ id: sessionParticipants.id })
          .from(sessionParticipants)
          .where(eq(sessionParticipants.providerIdentity, event.identity));
        if (seen) return;
        // Back in under a new identity before LiveKit said the old one left.
        await tx
          .update(sessionParticipants)
          .set({
            leftAt: sql`greatest(${stamp}, ${sessionParticipants.joinedAt})`,
          })
          .where(
            and(
              eq(sessionParticipants.sessionId, sessionId),
              eq(sessionParticipants.userId, userId),
              isNull(sessionParticipants.leftAt),
            ),
          );
        await tx.insert(sessionParticipants).values({
          sessionId,
          userId,
          providerIdentity: event.identity,
          joinedAt: at,
        });
        return;
      }
      case 'participant_left':
        await tx
          .update(sessionParticipants)
          .set({
            leftAt: sql`greatest(${stamp}, ${sessionParticipants.joinedAt})`,
          })
          .where(
            and(
              eq(sessionParticipants.providerIdentity, event.identity),
              isNull(sessionParticipants.leftAt),
            ),
          );
        return;
      case 'track_published':
        if (!event.video) return;
        await tx
          .update(sessionParticipants)
          .set({ videoEnabled: true })
          .where(
            and(
              eq(sessionParticipants.providerIdentity, event.identity),
              ne(sessionParticipants.videoEnabled, true),
            ),
          );
        return;
      case 'track_unpublished':
        return;
    }
  }

  /**
   * The session for this run of the room, locked so the run's events are
   * applied one at a time; opened if this is the first word of it. Null when
   * the event belongs to a run that has been replaced: another run of the
   * room opened after this event happened.
   */
  private async sessionFor(
    tx: Tx,
    { cohortId, spaceId }: SpaceRoom,
    roomId: string,
    at: Date,
  ): Promise<{ id: string; closed: boolean } | null> {
    const known = await this.lockedRun(tx, roomId);
    if (known) return known;

    const [open] = await tx
      .select({ id: sessions.id, openedAt: sessions.openedAt })
      .from(sessions)
      .where(
        and(
          eq(sessions.cohortId, cohortId),
          eq(sessions.spaceId, spaceId),
          isNull(sessions.closedAt),
        ),
      )
      .for('update');
    if (open) {
      if (at < open.openedAt) return null;
      // A newer run has started, so the open one is over, whether or not
      // its finish was heard.
      await tx
        .update(sessions)
        .set({
          closedAt: sql`greatest(${at.toISOString()}::timestamptz, ${sessions.openedAt})`,
        })
        .where(eq(sessions.id, open.id));
      await tx
        .update(sessionParticipants)
        .set({
          leftAt: sql`greatest(${at.toISOString()}::timestamptz, ${sessionParticipants.joinedAt})`,
        })
        .where(
          and(
            eq(sessionParticipants.sessionId, open.id),
            isNull(sessionParticipants.leftAt),
          ),
        );
    }

    const [inserted] = await tx
      .insert(sessions)
      .values({ cohortId, spaceId, providerRoomId: roomId, openedAt: at })
      .onConflictDoNothing()
      .returning({ id: sessions.id });
    if (inserted) return { id: inserted.id, closed: false };
    // Another delivery of this run opened it meanwhile.
    return (await this.lockedRun(tx, roomId)) ?? null;
  }

  private async lockedRun(
    tx: Tx,
    roomId: string,
  ): Promise<{ id: string; closed: boolean } | undefined> {
    const [run] = await tx
      .select({ id: sessions.id, closedAt: sessions.closedAt })
      .from(sessions)
      .where(eq(sessions.providerRoomId, roomId))
      .for('update');
    return run && { id: run.id, closed: run.closedAt !== null };
  }
}
