import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './../src/app.module.js';
import { DRIZZLE } from './../src/infra/database/database.constants.js';

/**
 * Generated clients and the Scalar UI read auth from the OpenAPI document, so
 * a public route marked as needing a token is a contract bug even though the
 * runtime lets it through.
 */
describe('OpenAPI security (e2e)', () => {
  let app: INestApplication;
  let security: (path: string, method: string) => unknown;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DRIZZLE)
      .useValue({})
      .compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('v1');
    await app.init();

    // Mirrors main.ts
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addServer('/v1').addBearerAuth().build(),
    );
    security = (path, method) =>
      (document.paths[path] as Record<string, { security?: unknown }>)[method]
        .security;
  });

  afterAll(async () => {
    await app.close();
  });

  it('marks the invite preview as public', () => {
    expect(security('/v1/invites/preview', 'post')).toBeUndefined();
  });

  it.each([
    ['/v1/invites', 'post'],
    ['/v1/invites/validate-user-invite', 'get'],
    ['/v1/invites/decision', 'post'],
    ['/v1/auth/me', 'get'],
  ])('still marks %s (%s) as needing a session', (path, method) => {
    expect(security(path, method)).toEqual([{ bearer: [] }]);
  });
});
