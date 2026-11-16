import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import * as schema from '../../infra/database/schema/index.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import {
  MediaNotFoundException,
  UploadNotFoundException,
} from '../media/media.exceptions.js';
import { MediaService } from '../media/media.service.js';
import { MediaKind, MediaStatus, media } from '../media/schema.js';
import { memoryMediaStorage } from '../media/testing/memory-media-storage.js';
import { SystemRole, users } from '../users/schema.js';
import { FeedbackService } from './feedback.service.js';
import { FeedbackType } from './schema.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);
const db = drizzle(new PGlite(), { schema });
const { objects, storage, upload } = memoryMediaStorage();
const mediaService = new MediaService(
  db as never,
  storage,
  { register: () => undefined } as never,
  { setContext: () => undefined, error: () => undefined } as never,
);
const service = new FeedbackService(db as never, mediaService);
service.onModuleInit();

let member: AuthenticatedUser;
let admin: AuthenticatedUser;
let otherAdmin: AuthenticatedUser;

const person = (row: typeof users.$inferSelect): AuthenticatedUser => ({
  id: row.id,
  email: row.email,
  systemRole: row.systemRole,
});
const screenshot = (userId = member.id) =>
  upload(mediaService, userId, MediaKind.FeedbackAttachment, {
    bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    contentType: 'image/png',
    fileName: 'door.png',
  });
const send = (attachmentIds: string[], extra: object = {}) =>
  service.create(
    member,
    {
      type: FeedbackType.Bug,
      title: 'The library door will not open',
      details: 'Nothing happens.',
      attachmentIds,
      ...extra,
    },
    undefined,
  );

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(
    sql`truncate feedback_attachments, media, feedback, users cascade`,
  );
  objects.clear();
  const [m, a, o] = await db
    .insert(users)
    .values([
      { email: 'member@campus.local' },
      { email: 'admin@campus.local', systemRole: SystemRole.Admin },
      { email: 'other@campus.local', systemRole: SystemRole.Admin },
    ])
    .returning();
  [member, admin, otherAdmin] = [person(m), person(a), person(o)];
});

describe('feedback attachments', () => {
  it('keeps the files with the feedback, kept forever, and shows them to an admin', async () => {
    const [first, second] = [await screenshot(), await screenshot()];

    const { id } = await send([first, second]);

    const read = await service.get(admin, id);
    expect(read.attachments).toEqual([
      expect.objectContaining({
        id: first,
        fileName: 'door.png',
        contentType: 'image/png',
        url: expect.stringMatching(/^https:\/\/r2\.test\/feedback\/.+\?read$/),
      }),
      expect.objectContaining({ id: second }),
    ]);
    const [row] = await db.select().from(media).where(eq(media.id, first));
    expect(row).toMatchObject({ status: MediaStatus.Ready, purgeAfter: null });
  });

  it('refuses an upload that is not the sender’s', async () => {
    const theirs = await screenshot(admin.id);

    await expect(send([theirs])).rejects.toThrow(UploadNotFoundException);
  });

  it('lets admins read a file and nobody else, the sender included', async () => {
    const file = await screenshot();
    await send([file]);

    await expect(
      mediaService.readUrl(admin, file, new Date()),
    ).resolves.toBeDefined();
    await expect(
      mediaService.readUrl(member, file, new Date()),
    ).rejects.toThrow(MediaNotFoundException);
  });

  it('keeps a report’s files from the admin it names', async () => {
    const file = await screenshot();
    await send([file], { type: FeedbackType.Report, reportedUserId: admin.id });

    await expect(mediaService.readUrl(admin, file, new Date())).rejects.toThrow(
      MediaNotFoundException,
    );
    await expect(
      mediaService.readUrl(otherAdmin, file, new Date()),
    ).resolves.toBeDefined();
  });
});
