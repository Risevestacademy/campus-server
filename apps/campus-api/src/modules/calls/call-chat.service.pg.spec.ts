import { spaceRoomName } from '@campus/media';
import { eq } from 'drizzle-orm';

import {
  REAL_POSTGRES_URL,
  connectRealPostgres,
  unique,
} from '../../infra/database/testing/real-postgres.js';
import { CohortRole, cohortMembers, cohorts } from '../cohorts/schema.js';
import {
  AudioMode,
  SpaceAccess,
  SpaceKind,
  maps,
  spaces,
} from '../maps/schema.js';
import { MediaService } from '../media/media.service.js';
import { MediaKind, MediaStatus, media } from '../media/schema.js';
import { memoryMediaStorage } from '../media/testing/memory-media-storage.js';
import { users } from '../users/schema.js';
import { CallChatService } from './call-chat.service.js';
import { NoOpenCallException } from './calls.exceptions.js';
import { CallsService } from './calls.service.js';

/**
 * A file sent as the call ends is either tied to the call and released with
 * it, or refused and left pending; never kept ready by a call that is over.
 * PGlite runs one transaction at a time, so only a real server can show it.
 */
describe.skipIf(!REAL_POSTGRES_URL)(
  'CallChatService, attach as the call ends',
  () => {
    let pg: ReturnType<typeof connectRealPostgres>;
    let mediaService: MediaService;
    let chat: CallChatService;
    let calls: CallsService;
    const { storage, upload } = memoryMediaStorage();

    beforeAll(() => {
      pg = connectRealPostgres();
      mediaService = new MediaService(
        pg.db as never,
        storage,
        { register: () => undefined } as never,
        { setContext: () => undefined, error: () => undefined } as never,
      );
      chat = new CallChatService(pg.db as never, mediaService);
      calls = new CallsService(
        pg.db as never,
        {} as never,
        { setContext: () => undefined, warn: () => undefined } as never,
        chat,
      );
    });

    afterAll(async () => {
      await pg.close();
    });

    async function aCall() {
      const tag = unique();
      const [map] = await pg.db
        .insert(maps)
        .values({ key: `chat-${tag}`, name: 'Chat' })
        .returning();
      const [space] = await pg.db
        .insert(spaces)
        .values({
          mapId: map.id,
          key: 'room',
          name: 'Room',
          kind: SpaceKind.MeetingRoom,
          audioMode: AudioMode.Boundary,
          access: SpaceAccess.Normal,
        })
        .returning();
      const [cohort] = await pg.db
        .insert(cohorts)
        .values({
          name: `Cohort ${tag}`,
          code: `C${tag}`.toUpperCase().slice(0, 32),
        })
        .returning();
      const [user] = await pg.db
        .insert(users)
        .values({ email: `chat-${tag}@campus.local` })
        .returning();
      await pg.db.insert(cohortMembers).values({
        userId: user.id,
        cohortId: cohort.id,
        role: CohortRole.Mentor,
      });
      const inRoom = {
        room: spaceRoomName({ cohortId: cohort.id, spaceId: space.id }),
        roomId: `RM_${tag}`,
        roomOpenedAt: new Date(0),
      };
      await calls.record({ kind: 'room_started', ...inRoom }, new Date());
      return {
        inRoom,
        userId: user.id,
        cohortId: cohort.id,
        spaceId: space.id,
      };
    }

    const ROUNDS = 20;

    it('never leaves a file ready once its call is over', async () => {
      const wrong: string[] = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        const { inRoom, userId, cohortId, spaceId } = await aCall();
        const mediaId = await upload(
          mediaService,
          userId,
          MediaKind.CallChatAttachment,
        );

        const [attached, finished] = await Promise.allSettled([
          chat.attach(userId, cohortId, spaceId, mediaId, new Date()),
          calls.record({ kind: 'room_finished', ...inRoom }, new Date()),
        ]);

        const [row] = await pg.db
          .select({ status: media.status })
          .from(media)
          .where(eq(media.id, mediaId));
        const refused =
          attached.status === 'rejected' &&
          attached.reason instanceof NoOpenCallException;
        const fine =
          finished.status === 'fulfilled' &&
          ((attached.status === 'fulfilled' &&
            row.status === MediaStatus.Removed) ||
            (refused && row.status === MediaStatus.Pending));
        if (!fine) {
          wrong.push(
            `round ${round}: attach ${attached.status}, finish ${finished.status}, file ${row.status}`,
          );
        }
      }
      expect(wrong).toEqual([]);
    }, 120_000);
  },
);
