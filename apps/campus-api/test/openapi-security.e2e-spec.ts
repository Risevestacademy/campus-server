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
  let schema: (name: string) => {
    required?: string[];
    properties: Record<string, { nullable?: boolean }>;
  };

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
      new DocumentBuilder().addBearerAuth().build(),
    );
    security = (path, method) =>
      (document.paths[path] as Record<string, { security?: unknown }>)[method]
        .security;
    schema = (name) => document.components?.schemas?.[name] as never;
  });

  afterAll(async () => {
    await app.close();
  });

  it('marks the invite preview as public', () => {
    expect(security('/v1/invites/preview', 'post')).toBeUndefined();
  });

  // The id_token in the body is the credential; there is no session yet.
  it('marks the native-app sign-in as public', () => {
    expect(security('/v1/auth/google/token', 'post')).toBeUndefined();
  });

  it.each([
    ['/v1/invites', 'post'],
    ['/v1/invites', 'get'],
    ['/v1/invites/{id}/revoke', 'post'],
    ['/v1/invites/validate-user-invite', 'get'],
    ['/v1/invites/decision', 'post'],
    ['/v1/invites/flag', 'post'],
    ['/v1/users', 'get'],
    ['/v1/auth/me', 'get'],
  ])('still marks %s (%s) as needing a session', (path, method) => {
    expect(security(path, method)).toEqual([{ bearer: [] }]);
  });

  /**
   * A native app's tokens come back in the body, and the fields with no
   * value are sent as null, never left out. Generated clients read that from
   * the document: required says the key is always there, nullable says it
   * may hold null. Optional would let a client model them as missing.
   */
  it.each([
    ['SessionTokensDto', 'refreshToken'],
    ['SessionTokensDto', 'refreshExpiresAt'],
    ['TokenSignInResponseDto', 'refreshToken'],
    ['TokenSignInResponseDto', 'refreshExpiresAt'],
    ['TokenSignInResponseDto', 'inviteId'],
  ])('documents %s.%s as always present, and nullable', (name, field) => {
    expect(schema(name).required).toContain(field);
    expect(schema(name).properties[field].nullable).toBe(true);
  });

  it.each([
    ['SessionTokensDto', 'scope'],
    ['SessionTokensDto', 'accessToken'],
    ['SessionTokensDto', 'expiresAt'],
  ])('documents %s.%s as always present, and never null', (name, field) => {
    expect(schema(name).required).toContain(field);
    expect(schema(name).properties[field].nullable).toBeUndefined();
  });
});
