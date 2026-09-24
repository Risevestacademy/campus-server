import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from './../src/app.module.js';
import { DRIZZLE } from './../src/infra/database/database.constants.js';
import {
  DomainExceptionFilter,
  GlobalExceptionFilter,
  ValidationExceptionFilter,
} from './../src/shared/filters/index.js';

/**
 * FF_GOOGLE_AUTH_ENABLED=false is what .env.example ships and what a fresh
 * deployment boots with, so the sign-in routes have to behave on a machine
 * that was never given Google credentials. They used to answer 500 and log
 * an unhandled exception.
 */
describe('Google sign-in while switched off (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    vi.stubEnv('FF_GOOGLE_AUTH_ENABLED', 'false');
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
    vi.stubEnv('AUTH_STATE_SECRET', '');

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      // The database is never reached: both routes refuse before any query.
      .overrideProvider(DRIZZLE)
      .useValue({})
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalFilters(
      new GlobalExceptionFilter(),
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('answers the start route as though it were not there', async () => {
    const res = await request(app.getHttpServer()).get('/v1/auth/google');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('answers the callback the same way, and sets no cookie', async () => {
    const res = await request(app.getHttpServer()).get(
      '/v1/auth/google/callback?code=abc&state=xyz',
    );

    expect(res.status).toBe(404);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});
