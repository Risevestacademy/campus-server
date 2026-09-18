import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import {
  SkipThrottle,
  ThrottlerGuard,
  ThrottlerModule,
} from '@nestjs/throttler';
import request from 'supertest';

const LIMIT = 3;

@Controller('limited')
class LimitedController {
  @Get()
  index(): string {
    return 'ok';
  }
}

@Controller('probe')
@SkipThrottle()
class ProbeController {
  @Get()
  index(): string {
    return 'ok';
  }
}

/**
 * Guards the fix for a live bug: without `trust proxy`, express reports the
 * proxy's address as the client for every request, so one bucket covered all
 * traffic and a single user could rate-limit the whole campus. These assert
 * the per-client behaviour rather than the setting, so removing the setting
 * fails here rather than in production.
 */
describe('rate limiting behind a proxy (e2e)', () => {
  let app: INestApplication;

  async function createApp(trustProxyHops: number) {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: LIMIT }])],
      controllers: [LimitedController, ProbeController],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();

    const created =
      moduleFixture.createNestApplication<NestExpressApplication>();
    created.set('trust proxy', trustProxyHops);
    await created.init();
    return created;
  }

  afterEach(async () => {
    await app?.close();
  });

  it('gives each forwarded client its own budget', async () => {
    app = await createApp(1);
    const server = app.getHttpServer();

    for (let i = 0; i < LIMIT * 3; i++) {
      await request(server)
        .get('/limited')
        .set('x-forwarded-for', `203.0.113.${i + 1}`)
        .expect(200);
    }
  });

  it('still limits a single client', async () => {
    app = await createApp(1);
    const server = app.getHttpServer();
    const client = '198.51.100.7';

    for (let i = 0; i < LIMIT; i++) {
      await request(server)
        .get('/limited')
        .set('x-forwarded-for', client)
        .expect(200);
    }

    await request(server)
      .get('/limited')
      .set('x-forwarded-for', client)
      .expect(429);
  });

  it('keeps health probes out of the budget entirely', async () => {
    app = await createApp(1);
    const server = app.getHttpServer();
    const client = '198.51.100.9';

    for (let i = 0; i < LIMIT + 1; i++) {
      await request(server)
        .get('/probe')
        .set('x-forwarded-for', client)
        .expect(200);
    }
  });

  it('shares one bucket when no proxy is trusted, which is why the setting exists', async () => {
    app = await createApp(0);
    const server = app.getHttpServer();

    for (let i = 0; i < LIMIT; i++) {
      await request(server)
        .get('/limited')
        .set('x-forwarded-for', `203.0.113.${i + 1}`)
        .expect(200);
    }

    // A different client, but the same socket, so the same bucket.
    await request(server)
      .get('/limited')
      .set('x-forwarded-for', '203.0.113.250')
      .expect(429);
  });
});
