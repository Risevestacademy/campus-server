import { setTimeout as sleep } from 'node:timers/promises';

import {
  REAL_POSTGRES_URL,
  connectRealPostgres,
  unique,
} from '../../infra/database/testing/real-postgres.js';
import { users } from '../users/schema.js';
import { UploadNotFoundException } from './media.exceptions.js';
import { MediaService } from './media.service.js';
import { MediaKind } from './schema.js';
import { memoryMediaStorage } from './testing/memory-media-storage.js';

/**
 * Two requests attaching the same uploads in opposite orders. Each claim
 * pauses once it holds its row, so the first request holds A while the second
 * holds B; locked in the order given, each would then wait on the other.
 *
 * See real-postgres.ts for why this cannot run on PGlite.
 */
describe.skipIf(!REAL_POSTGRES_URL)('MediaService, claims at once', () => {
  let pg: ReturnType<typeof connectRealPostgres>;
  let service: MediaService;
  const { storage, upload } = memoryMediaStorage();

  beforeAll(() => {
    pg = connectRealPostgres();
    service = new MediaService(
      pg.db as never,
      storage,
      { register: () => undefined } as never,
      { setContext: () => undefined, error: () => undefined } as never,
    );
    const claim = service.claim.bind(service);
    service.claim = async (...args) => {
      const row = await claim(...args);
      await sleep(100);
      return row;
    };
  });

  afterAll(async () => {
    await pg.close();
  });

  it('gives the files to one request and refuses the other, without a deadlock', async () => {
    const [user] = await pg.db
      .insert(users)
      .values({ email: `claims-${unique()}@campus.local` })
      .returning();
    const kind = MediaKind.NoticeAttachment;
    const a = await upload(service, user.id, kind);
    const b = await upload(service, user.id, kind);
    await service.verifyAll([a, b], kind, user.id, new Date());

    const claimAll = (ids: string[]) =>
      pg.db.transaction((tx) =>
        service.claimAll(tx as never, ids, kind, user.id, new Date()),
      );
    const results = await Promise.allSettled([
      claimAll([a, b]),
      claimAll([b, a]),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost.map((r) => r.reason)).toEqual([
      expect.any(UploadNotFoundException),
    ]);
  });
});
