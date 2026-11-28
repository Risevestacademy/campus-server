import { mayEnter } from '@campus/space-access';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';

import {
  DRIZZLE,
  type Db,
  type DbExecutor,
  type Tx,
} from '../../infra/database/database.constants.js';
import { MediaService, type Attachment } from '../media/media.service.js';
import { MediaKind } from '../media/schema.js';
import {
  CallChatForbiddenException,
  CallChatNotFoundException,
  NoOpenCallException,
} from './calls.exceptions.js';
import { callChatAttachments, sessions } from './schema.js';
import { personFacts, spaceFacts } from './space-access-facts.js';

const KIND = MediaKind.CallChatAttachment;

/**
 * Files sent in a call's chat. The line itself goes through world and is
 * never stored; the file is tied here to the call it was sent in. Whoever
 * may enter the space can open it until the call ends, when it is released.
 */
@Injectable()
export class CallChatService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly media: MediaService,
  ) {}

  onModuleInit(): void {
    this.media.registerReader(KIND, async (viewer, mediaId, now) => {
      const [call] = await this.db
        .select({ cohortId: sessions.cohortId, spaceId: sessions.spaceId })
        .from(callChatAttachments)
        .innerJoin(sessions, eq(sessions.id, callChatAttachments.sessionId))
        .where(eq(callChatAttachments.mediaId, mediaId));
      if (!call) return false;
      const [person, space] = await Promise.all([
        personFacts(this.db, viewer.id, call.cohortId),
        spaceFacts(this.db, call.spaceId),
      ]);
      return person !== null && space !== null && mayEnter(person, space, now);
    });
  }

  /** Ties an upload to the call going on in the space, for its chat. */
  async attach(
    userId: string,
    cohortId: string,
    spaceId: string,
    mediaId: string,
    now: Date,
  ): Promise<Attachment> {
    const [person, space] = await Promise.all([
      personFacts(this.db, userId, cohortId),
      spaceFacts(this.db, spaceId),
    ]);
    if (!space) {
      throw new CallChatNotFoundException('No space with that id', {
        spaceId,
      });
    }
    if (!person || !mayEnter(person, space, now)) {
      throw new CallChatForbiddenException('You may not enter this space', {
        cohortId,
        spaceId,
      });
    }
    if (!(await this.openCall(this.db, cohortId, spaceId))) {
      throw this.noCall(cohortId, spaceId);
    }

    await this.media.verify(mediaId, KIND, userId, now);
    const row = await this.db.transaction(async (tx) => {
      const call = await this.openCall(tx, cohortId, spaceId, true);
      if (!call) throw this.noCall(cohortId, spaceId);
      const ready = await this.media.claim(tx, mediaId, KIND, userId, now);
      await tx
        .insert(callChatAttachments)
        .values({ mediaId: ready.id, sessionId: call.id });
      return ready;
    });
    const [attachment] = await this.media.attachments([row], now);
    return attachment;
  }

  /** In the transaction that closes the call. */
  async release(tx: Tx, sessionId: string, at: Date): Promise<void> {
    const files = await tx
      .select({ id: callChatAttachments.mediaId })
      .from(callChatAttachments)
      .where(eq(callChatAttachments.sessionId, sessionId));
    await this.media.release(
      tx,
      files.map((file) => file.id),
      at,
    );
  }

  private async openCall(
    db: DbExecutor,
    cohortId: string,
    spaceId: string,
    lock = false,
  ): Promise<{ id: string } | undefined> {
    const query = db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.cohortId, cohortId),
          eq(sessions.spaceId, spaceId),
          isNull(sessions.closedAt),
        ),
      );
    const [call] = lock ? await query.for('update') : await query;
    return call;
  }

  private noCall(cohortId: string, spaceId: string): NoOpenCallException {
    return new NoOpenCallException('There is no call in this space', {
      cohortId,
      spaceId,
    });
  }
}
