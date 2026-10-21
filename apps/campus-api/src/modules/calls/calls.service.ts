import {
  InvalidWebhookError,
  parseSpaceRoomName,
  userIdOfIdentity,
  verifyCallWebhook,
  type CallEvent,
  type SpaceRoom,
} from '@campus/media';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, isNull, lte, ne, sql, type SQL } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';

import { CONFIG } from '../../infra/config/config.constants.js';
import type { Env } from '../../infra/config/env.js';
import {
  DRIZZLE,
  type Db,
  type Tx,
} from '../../infra/database/database.constants.js';
import { isForeignKeyViolation } from '../../infra/database/foreign-key-violation.js';
import {
  CallWebhookUnverifiedException,
  CallWebhooksNotConfiguredException,
} from './calls.exceptions.js';
import { sessionParticipants, sessions } from './schema.js';

function stamp(at: Date): SQL {
  return sql`${at.toISOString()}::timestamptz`;
}

/** `at`, or the row's join if that is later: a row never leaves before it joined. */
function leftAtNoEarlierThanJoin(at: Date): SQL {
  return sql`greatest(${stamp(at)}, ${sessionParticipants.joinedAt})`;
}

interface Run {
  id: string;
  closed: boolean;
}

/**
 * Writes what LiveKit says happened in a space's call. A session is one run
 * of a room, keyed by LiveKit's id for that run. LiveKit retries what it
 * could not deliver and does not promise order, so every event checks what
 * is already recorded: a repeat changes nothing, events arriving the wrong
 * way round still record who was there when, and an event from a run that
 * has since been replaced is dropped.
 */
@Injectable()
export class CallsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Env,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CallsService.name);
  }

  /** Checks a webhook came from LiveKit, then records it. */
  async receive(
    body: string,
    authorization: string | undefined,
  ): Promise<void> {
    const apiKey = this.config.LIVEKIT_WEBHOOK_API_KEY;
    const apiSecret = this.config.LIVEKIT_WEBHOOK_API_SECRET;
    if (!apiKey || !apiSecret) {
      throw new CallWebhooksNotConfiguredException(
        'Call webhooks are not configured here',
      );
    }
    let verified;
    try {
      verified = await verifyCallWebhook(
        { apiKey, apiSecret },
        body,
        authorization,
      );
    } catch (err: unknown) {
      if (err instanceof InvalidWebhookError) {
        throw new CallWebhookUnverifiedException(err.message);
      }
      throw err;
    }
    if (verified.event) {
      await this.record(verified.event, verified.at, verified.id);
    }
  }

  async record(event: CallEvent, at: Date, eventId?: string): Promise<void> {
    const room = parseSpaceRoomName(event.room);
    if (!room) return;
    try {
      await this.db.transaction((tx) => this.apply(tx, event, room, at));
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        this.logger.warn(
          { eventId, kind: event.kind, room: event.room },
          'call event for a cohort, space or account that is gone',
        );
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
    const run = await this.runFor(tx, room, event.roomId, event.roomOpenedAt);
    if (!run) return;

    switch (event.kind) {
      case 'room_started':
        return;
      case 'room_finished':
        await this.closeRun(tx, run.id, at);
        return;
      case 'participant_joined': {
        const userId = userIdOfIdentity(event.identity);
        if (!userId || run.closed) return;
        if (await this.seen(tx, event.identity)) return;
        const joinedAt = event.joinedAt ?? at;
        const theirs = and(
          eq(sessionParticipants.sessionId, run.id),
          eq(sessionParticipants.userId, userId),
        );
        // Their later entry is already recorded: this one ended when it began.
        const [newer] = await tx
          .select({ joinedAt: sessionParticipants.joinedAt })
          .from(sessionParticipants)
          .where(and(theirs, gt(sessionParticipants.joinedAt, joinedAt)))
          .orderBy(asc(sessionParticipants.joinedAt))
          .limit(1);
        if (newer) {
          await tx.insert(sessionParticipants).values({
            sessionId: run.id,
            userId,
            providerIdentity: event.identity,
            joinedAt,
            leftAt: newer.joinedAt,
          });
          return;
        }
        // Back in under a new identity before LiveKit said the old one left.
        await tx
          .update(sessionParticipants)
          .set({ leftAt: leftAtNoEarlierThanJoin(joinedAt) })
          .where(
            and(
              theirs,
              isNull(sessionParticipants.leftAt),
              lte(sessionParticipants.joinedAt, joinedAt),
            ),
          );
        await tx.insert(sessionParticipants).values({
          sessionId: run.id,
          userId,
          providerIdentity: event.identity,
          joinedAt,
        });
        return;
      }
      case 'participant_left': {
        const closed = await tx
          .update(sessionParticipants)
          .set({ leftAt: leftAtNoEarlierThanJoin(at) })
          .where(
            and(
              eq(sessionParticipants.providerIdentity, event.identity),
              isNull(sessionParticipants.leftAt),
            ),
          )
          .returning({ id: sessionParticipants.id });
        if (closed.length > 0 || (await this.seen(tx, event.identity))) return;
        // The leave came first: the row is recorded already over, so the
        // join that follows finds it and changes nothing.
        const userId = userIdOfIdentity(event.identity);
        if (!userId) return;
        const joinedAt = event.joinedAt ?? at;
        await tx.insert(sessionParticipants).values({
          sessionId: run.id,
          userId,
          providerIdentity: event.identity,
          joinedAt,
          leftAt: at > joinedAt ? at : joinedAt,
        });
        return;
      }
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

  private async seen(tx: Tx, identity: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: sessionParticipants.id })
      .from(sessionParticipants)
      .where(eq(sessionParticipants.providerIdentity, identity));
    return Boolean(row);
  }

  /** Closes a run and everybody still in it, at `at` or after they joined. */
  private async closeRun(tx: Tx, sessionId: string, at: Date): Promise<void> {
    await tx
      .update(sessions)
      .set({ closedAt: sql`greatest(${stamp(at)}, ${sessions.openedAt})` })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.closedAt)));
    await tx
      .update(sessionParticipants)
      .set({ leftAt: leftAtNoEarlierThanJoin(at) })
      .where(
        and(
          eq(sessionParticipants.sessionId, sessionId),
          isNull(sessionParticipants.leftAt),
        ),
      );
  }

  /**
   * The session for this run of the room, locked so the run's events are
   * applied one at a time; opened if this is the first word of it. Runs are
   * told apart by when LiveKit created them, to the millisecond. Null when
   * the event belongs to a run older than the one now open.
   */
  private async runFor(
    tx: Tx,
    { cohortId, spaceId }: SpaceRoom,
    roomId: string,
    roomOpenedAt: Date,
  ): Promise<Run | null> {
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
      if (roomOpenedAt <= open.openedAt) return null;
      // A newer run has started, so the open one is over, whether or not
      // its finish was heard.
      await this.closeRun(tx, open.id, roomOpenedAt);
    }

    const [inserted] = await tx
      .insert(sessions)
      .values({
        cohortId,
        spaceId,
        providerRoomId: roomId,
        openedAt: roomOpenedAt,
      })
      .onConflictDoNothing()
      .returning({ id: sessions.id });
    if (inserted) return { id: inserted.id, closed: false };
    // Another delivery of this run opened it meanwhile.
    return (await this.lockedRun(tx, roomId)) ?? null;
  }

  private async lockedRun(tx: Tx, roomId: string): Promise<Run | undefined> {
    const [run] = await tx
      .select({ id: sessions.id, closedAt: sessions.closedAt })
      .from(sessions)
      .where(eq(sessions.providerRoomId, roomId))
      .for('update');
    return run && { id: run.id, closed: run.closedAt !== null };
  }
}
