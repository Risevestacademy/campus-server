import { PGlite } from '@electric-sql/pglite';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from './../src/app.module.js';
import * as schema from './../src/infra/database/schema/index.js';
import { DRIZZLE } from './../src/infra/database/database.constants.js';
import { SessionIssuer } from './../src/modules/auth/session-issuer.js';
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
const db = drizzle(new PGlite(), { schema });

/**
 * Granting and revoking admin, from the outside. The rules are proven in the
 * service spec; what only shows here is that a role change is real — the
 * very next request is judged by the new role — and that a super admin is
 * let through every admin route.
 */
describe('PATCH /v1/users/:id/system-role (e2e)', () => {
  let app: INestApplication<App>;
  let root: typeof users.$inferSelect;
  let admin: typeof users.$inferSelect;
  let member: typeof users.$inferSelect;
  let rootToken: string;
  let adminToken: string;
  let memberToken: string;

  // Real tokens from the real issuer, so these hold whatever a session
  // token is made to carry.
  const tokenFor = async (user: typeof users.$inferSelect) =>
    (await app.get(SessionIssuer).issueFullAccess(user, { endsAt: null }))
      .token;

  const setRole = (token: string, userId: string, body: object) =>
    request(app.getHttpServer())
      .patch(`/v1/users/${userId}/system-role`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const listUsers = (token: string) =>
    request(app.getHttpServer())
      .get('/v1/users')
      .set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DRIZZLE)
      .useValue(db)
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
    // Listening once, rather than app.init(): supertest otherwise opens a
    // server on a new port for every request, and files running in parallel
    // collide on them.
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate audit_log, refresh_tokens, invites, cohort_members, users cascade`,
    );
    [root, admin, member] = await db
      .insert(users)
      .values([
        { email: 'root@campus.local', systemRole: SystemRole.SuperAdmin },
        { email: 'admin@campus.local', systemRole: SystemRole.Admin },
        { email: 'member@campus.local', systemRole: SystemRole.User },
      ])
      .returning();
    rootToken = await tokenFor(root);
    adminToken = await tokenFor(admin);
    memberToken = await tokenFor(member);
  });

  it('refuses without a session, and to somebody who is not an admin', async () => {
    await request(app.getHttpServer())
      .patch(`/v1/users/${member.id}/system-role`)
      .send({ systemRole: 'admin' })
      .expect(401);
    await setRole(memberToken, admin.id, { systemRole: 'user' }).expect(403);
  });

  it('lets a super admin through the admin routes', async () => {
    await listUsers(rootToken).expect(200);
  });

  // The guard reads the role from the row on every request, so there is
  // nothing to revoke and nothing to wait for.
  it('takes effect on the very next request, in both directions', async () => {
    await listUsers(memberToken).expect(403);

    const granted = await setRole(adminToken, member.id, {
      systemRole: 'admin',
    }).expect(200);
    expect(granted.body).toEqual({
      id: member.id,
      email: 'member@campus.local',
      systemRole: 'admin',
    });
    await listUsers(memberToken).expect(200);

    await setRole(adminToken, member.id, { systemRole: 'user' }).expect(200);
    await listUsers(memberToken).expect(403);
  });

  it('lets one admin revoke another', async () => {
    const [other] = await db
      .insert(users)
      .values({ email: 'other@campus.local', systemRole: SystemRole.Admin })
      .returning();

    await setRole(adminToken, other.id, { systemRole: 'user' }).expect(200);

    const [row] = await db.select().from(users).where(eq(users.id, other.id));
    expect(row.systemRole).toBe(SystemRole.User);
  });

  it('refuses to change a super admin, whoever asks', async () => {
    for (const token of [adminToken, rootToken]) {
      const res = await setRole(token, root.id, { systemRole: 'user' });
      // The super admin asking is also asking about themselves; either way
      // it is a 409.
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    }
    const [row] = await db.select().from(users).where(eq(users.id, root.id));
    expect(row.systemRole).toBe(SystemRole.SuperAdmin);
    await listUsers(rootToken).expect(200);
  });

  it('refuses an admin changing their own role', async () => {
    const res = await setRole(adminToken, admin.id, { systemRole: 'user' });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe(
      'You cannot change your own role: ask another admin',
    );
    await listUsers(adminToken).expect(200);
  });

  it.each([
    ['super_admin', { systemRole: 'super_admin' }],
    ['a role that does not exist', { systemRole: 'owner' }],
    ['nothing', {}],
  ])('rejects %s as the role', async (_label, body) => {
    const res = await setRole(adminToken, member.id, body);

    expect(res.status).toBe(400);
    expect(res.body.error.details.fields.systemRole).toEqual(
      expect.any(String),
    );
  });

  it('answers 404 for a missing user and 400 for a bad id', async () => {
    await setRole(adminToken, '99999999-9999-4999-8999-999999999999', {
      systemRole: 'admin',
    }).expect(404);
    await setRole(adminToken, 'not-a-uuid', { systemRole: 'admin' }).expect(
      400,
    );
  });

  // An invite is the other way a role is handed out, and must not be a way
  // round the rule that only the seed makes a super admin.
  it('refuses an invite that would make a super admin', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/invites')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'new@campus.local', systemRole: 'super_admin' });

    expect(res.status).toBe(400);
    expect(res.body.error.details.fields.systemRole).toEqual(
      expect.any(String),
    );
  });
});
