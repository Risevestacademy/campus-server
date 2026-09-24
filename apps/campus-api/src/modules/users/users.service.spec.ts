import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import type { Db } from '../../infra/database/database.constants.js';
import type { GoogleIdentity } from './google-identity.js';
import { SystemRole, UserStatus, users } from './schema.js';
import {
  GoogleIdentityMismatchError,
  hasGoogleIdentity,
  isAdmin,
  UsersService,
} from './users.service.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);

const pglite = drizzle(new PGlite(), { schema: { users } });
const db = pglite as unknown as Db;
const service = new UsersService(db);

function identity(overrides: Partial<GoogleIdentity> = {}): GoogleIdentity {
  return {
    subject: 'google-sub-1',
    email: 'ada@campus.local',
    firstName: 'Ada',
    lastName: 'Lovelace',
    displayName: 'Ada Lovelace',
    avatarUrl: 'https://example.test/ada.png',
    ...overrides,
  };
}

const allRows = () => pglite.select().from(users);

beforeAll(async () => {
  await migrate(pglite, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await pglite.execute(sql`truncate users cascade`);
});

describe('findForGoogleIdentity and linkGoogleIdentity', () => {
  it('finds an account by its Google subject', async () => {
    await service.createFromGoogleIdentity(identity());

    const found = await service.findForGoogleIdentity(identity());

    expect(found?.email).toBe('ada@campus.local');
    expect(found && hasGoogleIdentity(found)).toBe(true);
  });

  it('returns null when neither the subject nor the address is known', async () => {
    expect(await service.findForGoogleIdentity(identity())).toBeNull();
  });

  // The bootstrap case: the seeder writes an address and no subject, because
  // Google only issues one once that person actually signs in.
  it('links a seeded account by address on its first sign-in', async () => {
    await pglite.insert(users).values({
      email: 'admin@campus.local',
      systemRole: SystemRole.Admin,
    });

    const linked = await service.linkGoogleIdentity(
      identity({ email: 'admin@campus.local', subject: 'sub-admin' }),
    );

    expect(linked?.providerId).toBe('sub-admin');
    expect(linked && isAdmin(linked)).toBe(true);
    expect(await allRows()).toHaveLength(1);
  });

  it('fills blank profile fields when it links, and only blank ones', async () => {
    await pglite.insert(users).values({
      email: 'admin@campus.local',
      displayName: 'Campus Admin',
    });

    const linked = await service.linkGoogleIdentity(
      identity({ email: 'admin@campus.local' }),
    );

    expect(linked?.displayName).toBe('Campus Admin');
    expect(linked?.firstName).toBe('Ada');
    expect(linked?.avatarUrl).toBe('https://example.test/ada.png');
  });

  it('refuses to move an address already owned by another subject', async () => {
    await service.createFromGoogleIdentity(identity({ subject: 'first-sub' }));

    const hijack = await service.linkGoogleIdentity(
      identity({ subject: 'second-sub' }),
    );

    expect(hijack).toBeNull();
    expect((await allRows())[0].providerId).toBe('first-sub');
  });

  it('matches a differently cased address', async () => {
    await pglite.insert(users).values({ email: 'admin@campus.local' });

    const linked = await service.linkGoogleIdentity(
      identity({ email: 'Admin@Campus.Local' }),
    );

    expect(linked?.email).toBe('admin@campus.local');
  });
});

describe('createFromGoogleIdentity', () => {
  it('refuses to hand an address already bound to another subject', async () => {
    // A Workspace address reissued to a new person: the row still carries the
    // previous holder's role and memberships, so rebinding it would hand
    // those over rather than create an account.
    const [incumbent] = await pglite
      .insert(users)
      .values({
        email: 'ada@campus.local',
        provider: 'google',
        providerId: 'first-sub',
        systemRole: SystemRole.Admin,
      })
      .returning();

    await expect(
      service.createFromGoogleIdentity(identity({ subject: 'second-sub' })),
    ).rejects.toThrow(GoogleIdentityMismatchError);

    const [after] = await allRows();
    expect(after.id).toBe(incumbent.id);
    expect(after.providerId).toBe('first-sub');
    expect(after.systemRole).toBe(SystemRole.Admin);
  });

  it('is idempotent for the same subject, so a retry is harmless', async () => {
    const first = await service.createFromGoogleIdentity(identity());
    const again = await service.createFromGoogleIdentity(identity());

    expect(again.id).toBe(first.id);
    expect(await allRows()).toHaveLength(1);
  });

  it('creates an active, non-admin account', async () => {
    const created = await service.createFromGoogleIdentity(identity());

    expect(created.systemRole).toBe(SystemRole.User);
    expect(created.status).toBe(UserStatus.Active);
    expect(isAdmin(created)).toBe(false);
  });

  it('stores the address lowercased, as the check constraint demands', async () => {
    const created = await service.createFromGoogleIdentity(
      identity({ email: 'Ada@Campus.Local' }),
    );

    expect(created.email).toBe('ada@campus.local');
  });

  it('produces one account when two tabs finish the same first sign-in', async () => {
    const both = await Promise.all([
      service.createFromGoogleIdentity(identity()),
      service.createFromGoogleIdentity(identity()),
    ]);

    expect(await allRows()).toHaveLength(1);
    expect(both[0].id).toBe(both[1].id);
  });
});

describe('recordLogin', () => {
  it('stamps the account and leaves everything else alone', async () => {
    const created = await service.createFromGoogleIdentity(identity());
    expect(created.lastLoginAt).toBeNull();

    await service.recordLogin(created.id);

    const [row] = await allRows();
    expect(row.lastLoginAt).not.toBeNull();
    expect(row.email).toBe(created.email);
  });
});
