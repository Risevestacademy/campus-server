import {
  InvalidWebhookError,
  parseSpaceRoomName,
  userIdOfIdentity,
  verifyCallWebhook,
  type CallEvent,
  type SpaceRoom,
} from '@campus/media';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';

import type { EventProperties } from '@campus/analytics';

import {
  ANALYTICS,
  type Analytics,
} from '../../infra/analytics/analytics.module.js';
import { CONFIG } from '../../infra/config/config.constants.js';
import type { Env } from '../../infra/config/env.js';
import {
  DRIZZLE,
  type Db,
  type Tx,
} from '../../infra/database/database.constants.js';
import { isForeignKeyViolation } from '../../infra/database/foreign-key-violation.js';
import { timestamptz } from '../../infra/database/timestamptz.js';
import {
  CallWebhookUnverifiedException,
  CallWebhooksNotConfiguredException,
} from './calls.exceptions.js';
import { CallChatService } from './call-chat.service.js';
import { AnalyticsConsent, users } from '../users/schema.js';
import { spaces } from '../maps/schema.js';
import { RecordingsService } from './recordings.service.js';
import { sessionParticipants, sessions } from './schema.js';

/** `at`, or the row's join if that is later: a row never leaves before it joined. */
function leftAtNoEarlierThanJoin(at: Date): SQL {
  return sql`greatest(${timestamptz(at)}, ${sessionParticipants.joinedAt})`;
}

interface Run {
  id: string;
  closed: boolean;
}

/** The package's names are the enums' values, checked in analytics-catalogue.spec.ts. */
type SpaceKindName = EventProperties<'call.ended'>['space_kind'];

/** Somebody's time in a call, as it closed. */
const closedParticipant = {
  id: sessionParticipants.id,
  userId: sessionParticipants.userId,
  sessionId: sessionParticipants.sessionId,
  joinedAt: sessionParticipants.joinedAt,
  leftAt: sessionParticipants.leftAt,
  videoEnabled: sessionParticipants.videoEnabled,
};

type ClosedParticipant = {
  id: string;
  userId: string;
  sessionId: string;
  joinedAt: Date;
  leftAt: Date | null;
  videoEnabled: boolean;
};

/** What one event closed, counted once its transaction commits. */
interface Closings {
  participants: ClosedParticipant[];
  sessions: string[];
}

const seconds = (from: Date, to: Date | null): number =>
  to ? Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000)) : 0;

/** The most people in the call at once, from when each joined and left. */
export function peakOf(
  stays: readonly { joinedAt: Date; leftAt: Date | null }[],
): number {
  const edges = stays.flatMap(({ joinedAt, leftAt }) => [
    { at: joinedAt.getTime(), by: 1 },
    ...(leftAt ? [{ at: leftAt.getTime(), by: -1 }] : []),
  ]);
  // A leave at the same moment as a join comes first: they did not overlap.
  edges.sort((a, b) => a.at - b.at || a.by - b.by);
  let now = 0;
  let peak = 0;
  for (const { by } of edges) {
    now += by;
    peak = Math.max(peak, now);
  }
  return peak;
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
    private readonly chat: CallChatService,
    @Inject(ANALYTICS) private readonly analytics: Analytics,
    @Optional() private readonly recordings?: RecordingsService,
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
    if (verified.recording && this.recordings) {
      await this.recordings.record(verified.recording, verified.at);
    }
  }

  async record(event: CallEvent, at: Date, eventId?: string): Promise<void> {
    const room = parseSpaceRoomName(event.room);
    if (!room) return;
    const closed: Closings = { participants: [], sessions: [] };
    try {
      await this.db.transaction((tx) =>
        this.apply(tx, event, room, at, closed),
      );
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
    await this.trackClosings(closed);
  }

  /**
   * Who left a call, and calls that ended. Read after the commit, so a
   * retried delivery that changed nothing counts nothing. Never throws: the
   * webhook is recorded whatever becomes of its events.
   */
  private async trackClosings(closed: Closings): Promise<void> {
    if (closed.participants.length === 0 && closed.sessions.length === 0) {
      return;
    }
    try {
      const sessionIds = [
        ...new Set([
          ...closed.sessions,
          ...closed.participants.map((p) => p.sessionId),
        ]),
      ];
      const runs = new Map(
        (
          await this.db
            .select({
              id: sessions.id,
              cohortId: sessions.cohortId,
              openedAt: sessions.openedAt,
              closedAt: sessions.closedAt,
              spaceId: spaces.id,
              kind: spaces.kind,
              audioMode: spaces.audioMode,
            })
            .from(sessions)
            .innerJoin(spaces, eq(spaces.id, sessions.spaceId))
            .where(inArray(sessions.id, sessionIds))
        ).map((run) => [run.id, run]),
      );
      const fieldsOf = (run: { spaceId: string; kind: string | null }) => ({
        space_id: run.spaceId,
        space_kind: (run.kind ?? 'unset') as SpaceKindName,
      });

      const userIds = [...new Set(closed.participants.map((p) => p.userId))];
      const consenting = new Set(
        userIds.length === 0
          ? []
          : (
              await this.db
                .select({ id: users.id })
                .from(users)
                .where(
                  and(
                    inArray(users.id, userIds),
                    eq(users.analyticsConsent, AnalyticsConsent.Granted),
                  ),
                )
            ).map((row) => row.id),
      );

      for (const stay of closed.participants) {
        const run = runs.get(stay.sessionId);
        if (!run) continue;
        this.analytics.track(
          'call.left',
          stay.userId,
          {
            ...fieldsOf(run),
            audio_mode:
              run.audioMode as EventProperties<'call.left'>['audio_mode'],
            duration_s: seconds(stay.joinedAt, stay.leftAt),
            video_on: stay.videoEnabled,
          },
          {
            cohortId: run.cohortId,
            consented: consenting.has(stay.userId),
            sessionId: stay.id,
          },
        );
      }

      for (const sessionId of new Set(closed.sessions)) {
        const run = runs.get(sessionId);
        if (!run) continue;
        const stays = await this.db
          .select({
            userId: sessionParticipants.userId,
            joinedAt: sessionParticipants.joinedAt,
            leftAt: sessionParticipants.leftAt,
          })
          .from(sessionParticipants)
          .where(eq(sessionParticipants.sessionId, sessionId));
        this.analytics.trackAnonymous(
          'call.ended',
          {
            ...fieldsOf(run),
            duration_s: seconds(run.openedAt, run.closedAt),
            participants: new Set(stays.map((s) => s.userId)).size,
            peak_participants: peakOf(stays),
          },
          { cohortId: run.cohortId },
        );
      }
    } catch (err) {
      this.logger.warn({ err }, 'could not count call events');
    }
  }

  private async apply(
    tx: Tx,
    event: CallEvent,
    room: SpaceRoom,
    at: Date,
    closed: Closings,
  ): Promise<void> {
    const run = await this.runFor(
      tx,
      room,
      event.roomId,
      event.roomOpenedAt,
      closed,
    );
    if (!run) return;

    switch (event.kind) {
      case 'room_started':
        return;
      case 'room_finished':
        await this.closeRun(tx, run.id, at, closed);
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
          closed.participants.push(
            ...(await tx
              .insert(sessionParticipants)
              .values({
                sessionId: run.id,
                userId,
                providerIdentity: event.identity,
                joinedAt,
                leftAt: newer.joinedAt,
              })
              .returning(closedParticipant)),
          );
          return;
        }
        // Back in under a new identity before LiveKit said the old one left.
        closed.participants.push(
          ...(await tx
            .update(sessionParticipants)
            .set({ leftAt: leftAtNoEarlierThanJoin(joinedAt) })
            .where(
              and(
                theirs,
                isNull(sessionParticipants.leftAt),
                lte(sessionParticipants.joinedAt, joinedAt),
              ),
            )
            .returning(closedParticipant)),
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
        const left = await tx
          .update(sessionParticipants)
          .set({ leftAt: leftAtNoEarlierThanJoin(at) })
          .where(
            and(
              eq(sessionParticipants.providerIdentity, event.identity),
              isNull(sessionParticipants.leftAt),
            ),
          )
          .returning(closedParticipant);
        closed.participants.push(...left);
        if (left.length > 0 || (await this.seen(tx, event.identity))) return;
        // The leave came first: the row is recorded already over, so the
        // join that follows finds it and changes nothing.
        const userId = userIdOfIdentity(event.identity);
        if (!userId) return;
        const joinedAt = event.joinedAt ?? at;
        closed.participants.push(
          ...(await tx
            .insert(sessionParticipants)
            .values({
              sessionId: run.id,
              userId,
              providerIdentity: event.identity,
              joinedAt,
              leftAt: at > joinedAt ? at : joinedAt,
            })
            .returning(closedParticipant)),
        );
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

  /**
   * Closes a run and everybody still in it, at `at` or after they joined,
   * and lets go of the files sent in its chat.
   */
  private async closeRun(
    tx: Tx,
    sessionId: string,
    at: Date,
    closed: Closings,
  ): Promise<void> {
    const ended = await tx
      .update(sessions)
      .set({
        closedAt: sql`greatest(${timestamptz(at)}, ${sessions.openedAt})`,
      })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.closedAt)))
      .returning({ id: sessions.id });
    closed.sessions.push(...ended.map((run) => run.id));
    closed.participants.push(
      ...(await tx
        .update(sessionParticipants)
        .set({ leftAt: leftAtNoEarlierThanJoin(at) })
        .where(
          and(
            eq(sessionParticipants.sessionId, sessionId),
            isNull(sessionParticipants.leftAt),
          ),
        )
        .returning(closedParticipant)),
    );
    await this.chat.release(tx, sessionId, at);
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
    closed: Closings,
  ): Promise<Run | null> {
    const known = await this.lockedRun(tx, roomId);
    if (known) return known;

    const [open] = await tx
      .select({
        id: sessions.id,
        openedAt: sessions.openedAt,
        providerRoomId: sessions.providerRoomId,
      })
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
      // Opened by another delivery of this run since the lookup above.
      if (open.providerRoomId === roomId) return { id: open.id, closed: false };
      if (roomOpenedAt <= open.openedAt) return null;
      // A newer run has started, so the open one is over, whether or not
      // its finish was heard.
      await this.closeRun(tx, open.id, roomOpenedAt, closed);
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
