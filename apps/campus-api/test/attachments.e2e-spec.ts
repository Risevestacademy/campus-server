import { PGlite } from '@electric-sql/pglite';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SessionScope, signSessionToken } from '@campus/session';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from './../src/app.module.js';
import { DRIZZLE } from './../src/infra/database/database.constants.js';
import * as schema from './../src/infra/database/schema/index.js';
import { SESSION_COOKIE } from './../src/modules/auth/session-cookie.js';
import { sessions } from './../src/modules/calls/schema.js';
import {
  CohortRole,
  cohortMembers,
  cohorts,
} from './../src/modules/cohorts/schema.js';
import {
  AudioMode,
  SpaceAccess,
  SpaceKind,
  maps,
  spaces,
} from './../src/modules/maps/schema.js';
import { MEDIA_STORAGE } from './../src/modules/media/media-storage.js';
import { MediaStatus, media } from './../src/modules/media/schema.js';
import {
  memoryMediaStorage,
  PDF,
} from './../src/modules/media/testing/memory-media-storage.js';
import { SystemRole, users } from './../src/modules/users/schema.js';
import { ValidationException } from './../src/shared/exceptions/index.js';
import {
  DomainExceptionFilter,
  GlobalExceptionFilter,
  ValidationExceptionFilter,
} from './../src/shared/filters/index.js';

const MIGRATIONS = fileURLToPath(
  new URL('../src/infra/database/migrations', import.meta.url),
);
const SECRET = 'an-e2e-session-secret-of-at-least-32-chars';
const db = drizzle(new PGlite(), { schema });
const { objects, storage } = memoryMediaStorage();
const tooMany = Array.from(
  { length: 11 },
  (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
);
const badAttachmentIds = [tooMany, [tooMany[0], tooMany[0]], ['nope'], null];

describe('attachments (e2e)', () => {
  let app: INestApplication<App>;
  let adminCookie: string;
  let memberCookie: string;
  let outsiderCookie: string;
  let cohortId: string;

  const cookieFor = async (user: typeof users.$inferSelect) => {
    const { token } = await signSessionToken(
      {
        epoch: 0,
        userId: user.id,
        email: user.email,
        scope: SessionScope.FullAccess,
      },
      { secret: SECRET, ttlMinutes: 15 },
    );
    return `${SESSION_COOKIE}=${token}`;
  };

  /** Asks for an upload and PUTs a PDF to it, as the web app would. */
  const uploaded = async (cookie: string, kind: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/v1/uploads')
      .set('Cookie', cookie)
      .send({
        kind,
        contentType: 'application/pdf',
        sizeBytes: PDF.length,
        fileName: 'Term plan.pdf',
      })
      .expect(201);
    objects.set(`private:incoming/${res.body.mediaId}`, PDF);
    return res.body.mediaId;
  };
  const readUrl = (id: string, cookie: string) =>
    request(app.getHttpServer())
      .get(`/v1/media/${id}/url`)
      .set('Cookie', cookie);

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DRIZZLE)
      .useValue(db)
      .overrideProvider(MEDIA_STORAGE)
      .useValue(storage)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        exceptionFactory: (errors) => new ValidationException(errors),
      }),
    );
    app.useGlobalFilters(
      new GlobalExceptionFilter(),
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate call_chat_attachments, notice_attachments, feedback_attachments, media, sessions, spaces, maps, notifications, audit_log, notices, feedback, cohort_members, cohorts, users cascade`,
    );
    objects.clear();
    const [admin, member, outsider] = await db
      .insert(users)
      .values([
        { email: 'admin@campus.local', systemRole: SystemRole.Admin },
        { email: 'member@campus.local' },
        { email: 'outsider@campus.local' },
      ])
      .returning();
    const [cohort] = await db
      .insert(cohorts)
      .values({ name: 'Cohort 1', code: 'C1' })
      .returning();
    cohortId = cohort.id;
    await db.insert(cohortMembers).values({
      userId: member.id,
      cohortId: cohort.id,
      role: CohortRole.Mentor,
    });
    adminCookie = await cookieFor(admin);
    memberCookie = await cookieFor(member);
    outsiderCookie = await cookieFor(outsider);
  });

  describe('on a notice', () => {
    it('posts with a file that members then see and open, and nobody else does', async () => {
      const file = await uploaded(adminCookie, 'notice_attachment');

      const posted = await request(app.getHttpServer())
        .post('/v1/notices')
        .set('Cookie', adminCookie)
        .send({
          title: 'Term plan',
          body: 'Attached.',
          scope: 'campus',
          attachmentIds: [file],
        })
        .expect(201);
      expect(posted.body.attachments).toEqual([
        {
          id: file,
          fileName: 'Term plan.pdf',
          contentType: 'application/pdf',
          sizeBytes: PDF.length,
          url: expect.stringContaining('?read'),
          urlExpiresAt: expect.any(String),
        },
      ]);

      const wall = await request(app.getHttpServer())
        .get('/v1/notices')
        .set('Cookie', memberCookie)
        .expect(200);
      expect(wall.body.items[0].attachments[0].id).toBe(file);

      const link = await readUrl(file, memberCookie).expect(200);
      expect(link.body).toEqual({
        url: expect.stringContaining('?read'),
        expiresAt: expect.any(String),
      });
      const hidden = await readUrl(file, outsiderCookie).expect(404);
      expect(hidden.body.error.code).toBe('NOT_FOUND');
    });

    it('drops a file on an edit that leaves it out', async () => {
      const file = await uploaded(adminCookie, 'notice_attachment');
      const posted = await request(app.getHttpServer())
        .post('/v1/notices')
        .set('Cookie', adminCookie)
        .send({
          title: 'Term plan',
          body: 'Attached.',
          scope: 'campus',
          attachmentIds: [file],
        })
        .expect(201);

      const edited = await request(app.getHttpServer())
        .patch(`/v1/notices/${posted.body.id}`)
        .set('Cookie', adminCookie)
        .send({ attachmentIds: [] })
        .expect(200);

      expect(edited.body.attachments).toEqual([]);
      await readUrl(file, memberCookie).expect(404);
    });

    it('refuses more than ten files, repeats, and ids that are not ids', async () => {
      for (const attachmentIds of badAttachmentIds) {
        await request(app.getHttpServer())
          .post('/v1/notices')
          .set('Cookie', adminCookie)
          .send({ title: 'T', body: 'B', scope: 'campus', attachmentIds })
          .expect(400);
      }
    });
  });

  describe('on feedback', () => {
    it('sends with a file that admins open and the sender cannot', async () => {
      const file = await uploaded(memberCookie, 'feedback_attachment');

      const sent = await request(app.getHttpServer())
        .post('/v1/feedback')
        .set('Cookie', memberCookie)
        .send({
          type: 'bug',
          title: 'The door will not open',
          details: 'See the attached.',
          attachmentIds: [file],
        })
        .expect(201);

      const read = await request(app.getHttpServer())
        .get(`/v1/feedback/${sent.body.id}`)
        .set('Cookie', adminCookie)
        .expect(200);
      expect(read.body.attachments).toEqual([
        expect.objectContaining({ id: file, fileName: 'Term plan.pdf' }),
      ]);
      await readUrl(file, adminCookie).expect(200);
      await readUrl(file, memberCookie).expect(404);
    });

    it('refuses more than ten files, repeats, and ids that are not ids', async () => {
      for (const attachmentIds of badAttachmentIds) {
        await request(app.getHttpServer())
          .post('/v1/feedback')
          .set('Cookie', memberCookie)
          .send({
            type: 'bug',
            title: 'The door will not open',
            details: 'See the attached.',
            attachmentIds,
          })
          .expect(400);
      }
      await request(app.getHttpServer())
        .post('/v1/feedback')
        .set('Cookie', memberCookie)
        .send({
          type: 'bug',
          title: 'The door will not open',
          details: 'See the attached.',
          attachmentIds: [],
        })
        .expect(201);
    });
  });

  describe('in a call', () => {
    let spaceId: string;
    const attach = (mediaId: string, cookie = memberCookie) =>
      request(app.getHttpServer())
        .post(`/v1/cohorts/${cohortId}/spaces/${spaceId}/call/attachments`)
        .set('Cookie', cookie)
        .send({ mediaId });

    beforeEach(async () => {
      const [map] = await db
        .insert(maps)
        .values({ key: 'campus', name: 'Campus' })
        .returning();
      const [space] = await db
        .insert(spaces)
        .values({
          mapId: map.id,
          key: 'library',
          name: 'Library',
          kind: SpaceKind.MeetingRoom,
          audioMode: AudioMode.Boundary,
          access: SpaceAccess.Normal,
        })
        .returning();
      spaceId = space.id;
    });

    it('sends a file that others in the space open, until it is gone', async () => {
      await db
        .insert(sessions)
        .values({ cohortId, spaceId, providerRoomId: 'RM_1' });
      const file = await uploaded(memberCookie, 'call_chat_attachment');

      const sent = await attach(file).expect(201);

      expect(sent.body).toMatchObject({
        id: file,
        fileName: 'Term plan.pdf',
        url: expect.stringContaining('?read'),
      });
      await readUrl(file, adminCookie).expect(200);
      await readUrl(file, outsiderCookie).expect(404);

      await db
        .update(media)
        .set({
          status: MediaStatus.Removed,
          removedAt: new Date(),
          purgeAfter: new Date(),
        })
        .where(eq(media.id, file));
      const gone = await readUrl(file, adminCookie).expect(410);
      expect(gone.body.error.code).toBe('MEDIA_GONE');
      await readUrl(file, outsiderCookie).expect(404);
    });

    it('answers 409 with no call going on, and 403 to somebody not in the cohort', async () => {
      const file = await uploaded(memberCookie, 'call_chat_attachment');
      const conflict = await attach(file).expect(409);
      expect(conflict.body.error.code).toBe('CONFLICT');

      await db
        .insert(sessions)
        .values({ cohortId, spaceId, providerRoomId: 'RM_1' });
      await attach(
        await uploaded(outsiderCookie, 'call_chat_attachment'),
        outsiderCookie,
      ).expect(403);
      await attach('nope').expect(400);
    });
  });

  it('answers 400 for an id that is not one, and 401 without a session', async () => {
    await readUrl('nope', adminCookie).expect(400);
    await request(app.getHttpServer())
      .get('/v1/media/00000000-0000-4000-8000-000000000000/url')
      .expect(401);
  });
});
