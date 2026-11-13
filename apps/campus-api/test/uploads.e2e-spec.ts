import { S3Client } from '@aws-sdk/client-s3';
import { r2Connection } from '@campus/media';
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
import {
  MEDIA_STORAGE,
  r2Storage,
} from './../src/modules/media/media-storage.js';
import {
  MediaBucket,
  MediaStatus,
  media,
} from './../src/modules/media/schema.js';
import { users } from './../src/modules/users/schema.js';
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

// Signing is local, so the real signer runs with made-up credentials.
const storage = r2Storage(
  new S3Client({
    ...r2Connection('0123456789abcdef0123456789abcdef'),
    credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  }),
  {
    buckets: {
      [MediaBucket.Public]: 'campus-media',
      [MediaBucket.Private]: 'campus-private',
    },
    publicUrl: 'https://media.campus.test',
  },
);

describe('uploads (e2e)', () => {
  let app: INestApplication<App>;
  let member: typeof users.$inferSelect;
  let cookie: string;

  const create = (body: object, as = cookie) =>
    request(app.getHttpServer())
      .post('/v1/uploads')
      .set('Cookie', as)
      .send(body);

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
    await db.execute(sql`truncate media, users cascade`);
    [member] = await db
      .insert(users)
      .values({ email: 'member@campus.local' })
      .returning();
    const { token } = await signSessionToken(
      {
        epoch: 0,
        userId: member.id,
        email: member.email,
        scope: SessionScope.FullAccess,
      },
      { secret: SECRET, ttlMinutes: 15 },
    );
    cookie = `${SESSION_COOKIE}=${token}`;
  });

  it('refuses without a session', async () => {
    await request(app.getHttpServer())
      .post('/v1/uploads')
      .send({ kind: 'avatar', contentType: 'image/webp', sizeBytes: 100 })
      .expect(401);
  });

  it('signs a PUT for a profile picture into the private bucket', async () => {
    const res = await create({
      kind: 'avatar',
      contentType: 'image/webp',
      sizeBytes: 48213,
    }).expect(201);

    expect(res.body).toEqual({
      mediaId: expect.any(String),
      uploadUrl: expect.any(String),
      method: 'PUT',
      headers: { 'Content-Type': 'image/webp' },
      expiresAt: expect.any(String),
    });
    const url = new URL(res.body.uploadUrl);
    expect(url.pathname).toBe(`/campus-private/incoming/${res.body.mediaId}`);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host',
    );

    const [row] = await db
      .select()
      .from(media)
      .where(eq(media.id, res.body.mediaId));
    expect(row).toMatchObject({
      status: MediaStatus.Pending,
      uploadedBy: member.id,
      sizeBytes: 48213,
      key: null,
    });
  });

  it('answers 415 for a type and 413 for a size the kind does not take', async () => {
    const type = await create({
      kind: 'avatar',
      contentType: 'image/gif',
      sizeBytes: 100,
    }).expect(415);
    expect(type.body.error).toMatchObject({
      code: 'UPLOAD_TYPE_NOT_ALLOWED',
      details: { allowed: ['image/jpeg', 'image/png', 'image/webp'] },
    });

    const size = await create({
      kind: 'avatar',
      contentType: 'image/png',
      sizeBytes: 3 * 1024 * 1024,
    }).expect(413);
    expect(size.body.error).toMatchObject({
      code: 'UPLOAD_TOO_LARGE',
      details: { maxBytes: 2 * 1024 * 1024 },
    });
  });

  it('refuses an unknown kind or a size that is no size', async () => {
    await create({
      kind: 'video',
      contentType: 'video/mp4',
      sizeBytes: 100,
    }).expect(400);
    await create({
      kind: 'avatar',
      contentType: 'image/png',
      sizeBytes: 0,
    }).expect(400);
  });

  it('lists what each kind may be', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/uploads/limits')
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body).toEqual({
      kinds: [
        {
          kind: 'avatar',
          contentTypes: ['image/jpeg', 'image/png', 'image/webp'],
          maxBytes: 2 * 1024 * 1024,
        },
      ],
    });
  });
});
