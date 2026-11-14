import { PGlite } from '@electric-sql/pglite';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SessionScope, signSessionToken } from '@campus/session';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from './../src/app.module.js';
import { CONFIG } from './../src/infra/config/config.constants.js';
import { loadEnv, type Env } from './../src/infra/config/env.js';
import { DRIZZLE } from './../src/infra/database/database.constants.js';
import * as schema from './../src/infra/database/schema/index.js';
import { SESSION_COOKIE } from './../src/modules/auth/session-cookie.js';
import {
  MEDIA_STORAGE,
  type MediaStorage,
} from './../src/modules/media/media-storage.js';
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
const GOOGLE = 'https://lh3.googleusercontent.com/a/ada';
const db = drizzle(new PGlite(), { schema });
const config: Env = {
  ...loadEnv(),
  MEDIA_PUBLIC_URL: 'https://media.campus.test',
};

const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

/** R2 as a map of `bucket:key` to bytes. */
const objects = new Map<string, Uint8Array>();
const storage: MediaStorage = {
  async signUpload(key, terms) {
    return {
      url: `https://r2.test/${key}`,
      headers: { 'Content-Type': terms.contentType },
    };
  },
  async copyUpload(uploadKey, to) {
    const bytes = objects.get(`private:${uploadKey}`);
    if (!bytes) throw new Error('NoSuchKey');
    objects.set(`${to.bucket}:${to.key}`, bytes);
  },
  async head(bucket, key) {
    const bytes = objects.get(`${bucket}:${key}`);
    return bytes
      ? { sizeBytes: bytes.length, contentType: 'image/webp' }
      : null;
  },
  async readStart(bucket, key, length) {
    return (
      objects.get(`${bucket}:${key}`)?.subarray(0, length) ?? new Uint8Array()
    );
  },
  async delete(bucket, key) {
    objects.delete(`${bucket}:${key}`);
  },
  publicUrl: (key) => `${config.MEDIA_PUBLIC_URL}/${key}`,
};

describe('profile picture (e2e)', () => {
  let app: INestApplication<App>;
  let cookie: string;

  /** Asks for an upload and PUTs a picture to it, as the web app would. */
  const uploaded = async (): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/v1/uploads')
      .set('Cookie', cookie)
      .send({
        kind: 'avatar',
        contentType: 'image/webp',
        sizeBytes: WEBP.length,
      })
      .expect(201);
    objects.set(`private:incoming/${res.body.mediaId}`, WEBP);
    return res.body.mediaId;
  };

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DRIZZLE)
      .useValue(db)
      .overrideProvider(CONFIG)
      .useValue(config)
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
    objects.clear();
    const [ada] = await db
      .insert(users)
      .values({ email: 'ada@campus.local', googlePictureUrl: GOOGLE })
      .returning();
    const { token } = await signSessionToken(
      {
        epoch: 0,
        userId: ada.id,
        email: ada.email,
        scope: SessionScope.FullAccess,
      },
      { secret: SECRET, ttlMinutes: 15 },
    );
    cookie = `${SESSION_COOKIE}=${token}`;
  });

  it('sets an uploaded picture, which the session and profile then show', async () => {
    const mediaId = await uploaded();

    const set = await request(app.getHttpServer())
      .put('/v1/users/me/avatar')
      .set('Cookie', cookie)
      .send({ mediaId })
      .expect(200);

    expect(set.body.avatarUrl).toMatch(
      /^https:\/\/media\.campus\.test\/avatars\/[0-9a-f-]+\/[0-9a-f-]+\.webp$/,
    );
    const session = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('Cookie', cookie)
      .expect(200);
    expect(session.body.user.avatarUrl).toBe(set.body.avatarUrl);
  });

  it('removes it, leaving initials rather than Google’s picture', async () => {
    await request(app.getHttpServer())
      .put('/v1/users/me/avatar')
      .set('Cookie', cookie)
      .send({ mediaId: await uploaded() })
      .expect(200);

    const removed = await request(app.getHttpServer())
      .delete('/v1/users/me/avatar')
      .set('Cookie', cookie)
      .expect(200);

    expect(removed.body.avatarUrl).toBeNull();
    const own = await request(app.getHttpServer())
      .get('/v1/users/me')
      .set('Cookie', cookie)
      .expect(200);
    expect(own.body.avatarUrl).toBeNull();
  });

  it('answers 404 for an upload that is not waiting, and 400 for no id', async () => {
    const missing = await request(app.getHttpServer())
      .put('/v1/users/me/avatar')
      .set('Cookie', cookie)
      .send({ mediaId: '00000000-0000-4000-8000-000000000000' })
      .expect(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');

    await request(app.getHttpServer())
      .put('/v1/users/me/avatar')
      .set('Cookie', cookie)
      .send({ mediaId: 'nope' })
      .expect(400);
  });

  it('answers 422 when nothing was put to the upload URL', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/uploads')
      .set('Cookie', cookie)
      .send({ kind: 'avatar', contentType: 'image/webp', sizeBytes: 12 })
      .expect(201);

    const refused = await request(app.getHttpServer())
      .put('/v1/users/me/avatar')
      .set('Cookie', cookie)
      .send({ mediaId: res.body.mediaId })
      .expect(422);
    expect(refused.body.error.code).toBe('UPLOAD_MISMATCH');
  });

  it('refuses without a session', async () => {
    await request(app.getHttpServer())
      .delete('/v1/users/me/avatar')
      .expect(401);
  });
});
