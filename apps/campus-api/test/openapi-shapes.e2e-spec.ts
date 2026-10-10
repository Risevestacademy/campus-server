import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './../src/app.module.js';
import { DRIZZLE } from './../src/infra/database/database.constants.js';

type Schema = {
  type?: string;
  format?: string;
  nullable?: boolean;
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: unknown;
  items?: Schema;
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  enum?: unknown[];
  $ref?: string;
};

/**
 * The web app generates its API types from this document, so a shape that is
 * wrong here is wrong in every caller, whatever the route really sends. These
 * read the document as a generator does and look for the two ways it has gone
 * wrong: a field with no type, and a list whose items are typed twice.
 */
describe('OpenAPI shapes (e2e)', () => {
  let app: INestApplication;
  let schemas: Record<string, Schema>;
  let paths: Record<string, Record<string, { responses?: unknown }>>;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DRIZZLE)
      .useValue({})
      .compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('v1');
    await app.listen(0);

    // Mirrors main.ts
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    );
    schemas = document.components?.schemas as never;
    paths = document.paths as never;
  });

  afterAll(async () => {
    await app.close();
  });

  const okSchema = (path: string): Schema =>
    (
      paths[path].get.responses as Record<
        string,
        { content: Record<string, { schema: Schema }> }
      >
    )['200'].content['application/json'].schema;
  const named = (ref: string | undefined) =>
    (ref ?? '').replace('#/components/schemas/', '');

  // `string | null` with no type given is documented as an object with
  // nothing in it, which a client generates as a value it can do nothing
  // with. Anything that really is a free-form object says so.
  it('gives every field a type', () => {
    const untyped: string[] = [];
    for (const [name, schema] of Object.entries(schemas)) {
      for (const [field, property] of Object.entries(schema.properties ?? {})) {
        const says =
          property.$ref ??
          property.allOf ??
          property.oneOf ??
          property.anyOf ??
          property.enum ??
          property.properties ??
          property.additionalProperties ??
          property.items;
        if (
          says === undefined &&
          (!property.type || property.type === 'object')
        ) {
          untyped.push(`${name}.${field}`);
        }
      }
    }

    expect(untyped).toEqual([]);
  });

  it('sends the invite receipt’s identifiers as ids, or null, never left out', () => {
    const receipt = schemas.InviteResponseDto;

    for (const field of ['cohortId', 'cohortTrackId', 'mentorshipGroupId']) {
      expect(receipt.properties?.[field], field).toMatchObject({
        type: 'string',
        format: 'uuid',
        nullable: true,
      });
      expect(receipt.required, field).toContain(field);
    }
    expect(receipt.required).toEqual(
      expect.arrayContaining(['cohortRole', 'guestAccessExpiresAt']),
    );
  });

  // Each list is a schema of its own with `items` typed as the item. The
  // generic envelope it used to be composed with claimed `items` for itself,
  // and the two together were an array of two things at once.
  it.each([
    ['/v1/invites', 'AdminInviteListItemDto'],
    ['/v1/tracks', 'TrackResponseDto'],
    ['/v1/cohorts', 'CohortResponseDto'],
    ['/v1/cohorts/{id}/members', 'RosterMemberDto'],
    ['/v1/users', 'UserListItemDto'],
    ['/v1/audit-log', 'AuditLogEntryDto'],
  ])('types the page of %s directly, as %s', (path, item) => {
    const response = okSchema(path);

    expect(response.allOf).toBeUndefined();
    const page = schemas[named(response.$ref)];
    expect(named(response.$ref)).toBe(`Paginated${item}`);
    expect(page.required).toEqual(expect.arrayContaining(['items', 'meta']));
    expect(page.properties?.items).toMatchObject({
      type: 'array',
      items: { $ref: `#/components/schemas/${item}` },
    });
    expect(JSON.stringify(page.properties?.meta)).toContain(
      '#/components/schemas/PaginationMetaDto',
    );
  });

  it('no longer documents a generic page whose items are strings', () => {
    expect(schemas.PaginatedResponseDto).toBeUndefined();
  });
});
