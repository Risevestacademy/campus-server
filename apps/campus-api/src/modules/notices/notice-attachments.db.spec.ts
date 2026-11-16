import { PGlite } from '@electric-sql/pglite';
import { eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import * as schema from '../../infra/database/schema/index.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CohortRole, cohortMembers, cohorts } from '../cohorts/schema.js';
import {
  MediaNotFoundException,
  UploadMismatchException,
  UploadNotFoundException,
} from '../media/media.exceptions.js';
import { MediaService } from '../media/media.service.js';
import { MediaKind, MediaStatus, media } from '../media/schema.js';
import { memoryMediaStorage } from '../media/testing/memory-media-storage.js';
import type { NotificationPush } from '../notifications/notification-push.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { SystemRole, users } from '../users/schema.js';
import { NoticesService } from './notices.service.js';
import { NoticeScope, noticeAttachments } from './schema.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);
const DAY_MS = 24 * 60 * 60_000;
const db = drizzle(new PGlite(), { schema });
const { objects, storage, upload } = memoryMediaStorage();
const mediaService = new MediaService(
  db as never,
  storage,
  { register: () => undefined } as never,
  { setContext: () => undefined, error: () => undefined } as never,
);
const service = new NoticesService(
  db as never,
  new NotificationsService(db as never),
  { send: async () => undefined } as unknown as NotificationPush,
  mediaService,
);
service.onModuleInit();

let admin: AuthenticatedUser;
let member: AuthenticatedUser;
let outsider: AuthenticatedUser;
let cohortId: string;

const person = (row: typeof users.$inferSelect): AuthenticatedUser => ({
  id: row.id,
  email: row.email,
  systemRole: row.systemRole,
});
const audit = () => ({ actorUserId: admin.id });
const attachment = () =>
  upload(mediaService, admin.id, MediaKind.NoticeAttachment);
const post = (attachmentIds: string[]) =>
  service.create(
    {
      title: 'Timetable',
      body: 'Attached.',
      scope: NoticeScope.Cohort,
      cohortId,
      attachmentIds,
    },
    admin,
    audit(),
  );
const statusOf = async (id: string) =>
  (await db.select().from(media).where(eq(media.id, id)))[0];

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(
    sql`truncate notice_attachments, media, notifications, audit_log, notices, cohort_members, cohorts, users cascade`,
  );
  objects.clear();
  const [a, m, o] = await db
    .insert(users)
    .values([
      { email: 'admin@campus.local', systemRole: SystemRole.Admin },
      { email: 'member@campus.local' },
      { email: 'outsider@campus.local' },
    ])
    .returning();
  [admin, member, outsider] = [person(a), person(m), person(o)];
  const [cohort] = await db
    .insert(cohorts)
    .values({ name: 'Cohort 1', code: 'C1' })
    .returning();
  cohortId = cohort.id;
  await db
    .insert(cohortMembers)
    .values({ userId: member.id, cohortId, role: CohortRole.Mentor });
});

describe('notice attachments', () => {
  it('posts a notice with files, in the order given, and lists them with links', async () => {
    const [first, second] = [await attachment(), await attachment()];

    const notice = await post([second, first]);

    expect(notice.attachments).toEqual([
      expect.objectContaining({
        id: second,
        fileName: 'plan.pdf',
        contentType: 'application/pdf',
        url: expect.stringMatching(/^https:\/\/r2\.test\/notices\/.+\?read$/),
        urlExpiresAt: expect.any(Date),
      }),
      expect.objectContaining({ id: first }),
    ]);
    const page = await service.list(member, { page: 1, perPage: 20 } as never);
    expect(page.items[0].attachments.map((a) => a.id)).toEqual([second, first]);
    expect((await statusOf(first)).status).toBe(MediaStatus.Ready);
  });

  it('lists a notice without files with an empty list', async () => {
    const notice = await post([]);

    expect(notice.attachments).toEqual([]);
  });

  it('refuses someone else’s upload, an upload of another kind, and a file that is not what was signed', async () => {
    const theirs = await upload(
      mediaService,
      member.id,
      MediaKind.NoticeAttachment,
    );
    await expect(post([theirs])).rejects.toThrow(UploadNotFoundException);

    const feedbackFile = await upload(
      mediaService,
      admin.id,
      MediaKind.FeedbackAttachment,
    );
    await expect(post([feedbackFile])).rejects.toThrow(UploadNotFoundException);

    const fake = await upload(
      mediaService,
      admin.id,
      MediaKind.NoticeAttachment,
      {
        bytes: new TextEncoder().encode('not a pdf at all'),
      },
    );
    await expect(post([fake])).rejects.toThrow(UploadMismatchException);
  });

  it('will not take a file already on another notice', async () => {
    const file = await attachment();
    await post([file]);

    await expect(post([file])).rejects.toThrow(UploadNotFoundException);
  });

  it('replaces the list on an edit: new files claimed, dropped ones released with a week’s grace', async () => {
    const [kept, dropped] = [await attachment(), await attachment()];
    const notice = await post([kept, dropped]);
    const added = await attachment();
    const now = new Date();

    const edited = await service.update(
      notice.id,
      { attachmentIds: [added, kept] },
      admin,
      audit(),
      now,
    );

    expect(edited.attachments.map((a) => a.id)).toEqual([added, kept]);
    expect(await statusOf(dropped)).toMatchObject({
      status: MediaStatus.Removed,
      purgeAfter: new Date(now.getTime() + 7 * DAY_MS),
    });
    expect((await statusOf(added)).status).toBe(MediaStatus.Ready);
    expect((await statusOf(kept)).status).toBe(MediaStatus.Ready);
  });

  it('leaves the files alone on an edit that does not send the list', async () => {
    const file = await attachment();
    const notice = await post([file]);

    const edited = await service.update(
      notice.id,
      { title: 'New title' },
      admin,
      audit(),
    );

    expect(edited.attachments.map((a) => a.id)).toEqual([file]);
  });

  it('releases every file when the notice is removed', async () => {
    const files = [await attachment(), await attachment()];
    const notice = await post(files);

    await service.remove(notice.id, admin, audit());

    const rows = await db.select().from(media).where(inArray(media.id, files));
    expect(rows.map((row) => row.status)).toEqual([
      MediaStatus.Removed,
      MediaStatus.Removed,
    ]);
    expect(
      await db
        .select()
        .from(noticeAttachments)
        .where(eq(noticeAttachments.noticeId, notice.id)),
    ).toHaveLength(2);
  });

  describe('reading a file', () => {
    it('gives a link to whoever can see the notice, and the same 404 to anyone else', async () => {
      const file = await attachment();
      await post([file]);

      await expect(
        mediaService.readUrl(member, file, new Date()),
      ).resolves.toMatchObject({ url: expect.stringContaining('?read') });
      await expect(
        mediaService.readUrl(admin, file, new Date()),
      ).resolves.toBeDefined();
      await expect(
        mediaService.readUrl(outsider, file, new Date()),
      ).rejects.toThrow(MediaNotFoundException);
    });

    it('stops once the notice is removed', async () => {
      const file = await attachment();
      const notice = await post([file]);
      await service.remove(notice.id, admin, audit());

      await expect(
        mediaService.readUrl(member, file, new Date()),
      ).rejects.toThrow(MediaNotFoundException);
    });

    it('gives nothing for an upload no notice carries yet', async () => {
      const file = await attachment();

      await expect(
        mediaService.readUrl(admin, file, new Date()),
      ).rejects.toThrow(MediaNotFoundException);
    });
  });
});
