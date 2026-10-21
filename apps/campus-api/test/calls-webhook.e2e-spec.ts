import { signCallWebhook, spaceRoomName } from '@campus/media';
import { PGlite } from '@electric-sql/pglite';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

import { AppModule } from './../src/app.module.js';
import { CONFIG } from './../src/infra/config/config.constants.js';
import { loadEnv, type Env } from './../src/infra/config/env.js';
import { DRIZZLE } from './../src/infra/database/database.constants.js';
import * as schema from './../src/infra/database/schema/index.js';
import {
  sessionParticipants,
  sessions,
} from './../src/modules/calls/schema.js';
import { cohorts } from './../src/modules/cohorts/schema.js';
import {
  AudioMode,
  SpaceAccess,
  maps,
  spaces,
} from './../src/modules/maps/schema.js';
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
const db = drizzle(new PGlite(), { schema });
const KEYS = { apiKey: 'webhook-key', apiSecret: 'w'.repeat(32) };
const config: Env = {
  ...loadEnv(),
  LIVEKIT_WEBHOOK_API_KEY: KEYS.apiKey,
  LIVEKIT_WEBHOOK_API_SECRET: KEYS.apiSecret,
};

/** LiveKit's posts as LiveKit signs them: a token carrying the body's hash. */
async function webhook(event: object, apiSecret = KEYS.apiSecret) {
  const body = JSON.stringify(event);
  return {
    body,
    authorization: await signCallWebhook(
      { apiKey: KEYS.apiKey, apiSecret },
      body,
    ),
  };
}

describe('LiveKit webhooks (e2e)', () => {
  let app: NestExpressApplication;
  let room: string;
  let userId: string;

  const post = (body: string, authorization?: string) => {
    const req = request(app.getHttpServer())
      .post('/v1/calls/webhook')
      .set('content-type', 'application/webhook+json');
    return (authorization ? req.set('authorization', authorization) : req).send(
      body,
    );
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
      .compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>({
      rawBody: true,
    });
    app.useBodyParser('json', { type: 'application/webhook+json' });
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
    config.LIVEKIT_WEBHOOK_API_KEY = KEYS.apiKey;
    config.LIVEKIT_WEBHOOK_API_SECRET = KEYS.apiSecret;
    await db.execute(
      sql`truncate session_participants, sessions, spaces, maps, cohorts, users cascade`,
    );
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
        audioMode: AudioMode.Boundary,
        access: SpaceAccess.Normal,
      })
      .returning();
    const [cohort] = await db
      .insert(cohorts)
      .values({ name: 'C1', code: 'C1' })
      .returning();
    const [user] = await db
      .insert(users)
      .values({ email: 'ada@campus.local' })
      .returning();
    room = spaceRoomName({ cohortId: cohort.id, spaceId: space.id });
    userId = user.id;
  });

  it('records a call and who joined it, from LiveKit’s signed posts', async () => {
    for (const [event, id] of [
      ['room_started', 'EV_1'],
      ['participant_joined', 'EV_2'],
    ] as const) {
      const { body, authorization } = await webhook({
        event,
        id,
        createdAt: '1792500000',
        room: { name: room, sid: 'RM_1' },
        participant: { identity: `${userId}:abc` },
      });
      await post(body, authorization).expect(204);
    }

    await expect(db.select().from(sessions)).resolves.toHaveLength(1);
    await expect(db.select().from(sessionParticipants)).resolves.toEqual([
      expect.objectContaining({ userId, providerIdentity: `${userId}:abc` }),
    ]);
  });

  it('refuses a post with no signature, or one signed with another secret', async () => {
    const event = {
      event: 'room_started',
      id: 'EV_3',
      createdAt: '1792500000',
      room: { name: room, sid: 'RM_1' },
    };
    const forged = await webhook(event, 'x'.repeat(32));

    await post(forged.body).expect(401);
    await post(forged.body, forged.authorization).expect(401);
    await expect(db.select().from(sessions)).resolves.toEqual([]);
  });

  it('answers 503 where no key pair is set', async () => {
    config.LIVEKIT_WEBHOOK_API_KEY = undefined;
    config.LIVEKIT_WEBHOOK_API_SECRET = undefined;
    const { body, authorization } = await webhook({
      event: 'room_started',
      id: 'EV_4',
      createdAt: '1792500000',
      room: { name: room, sid: 'RM_1' },
    });

    await post(body, authorization).expect(503);
  });
});
