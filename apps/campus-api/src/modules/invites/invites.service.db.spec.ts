import { createHash } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import {
  CohortRole,
  CohortStatus,
  cohortTracks,
  cohorts,
} from '../cohorts/schema.js';
import { tracks } from '../tracks/schema.js';
import { SystemRole, users } from '../users/schema.js';
import { generateInviteToken, hashInviteToken } from './invite-token.js';
import {
  InviteConflictException,
  InviteInvalidArgumentException,
} from './invites.exceptions.js';
import {
  InvitesService,
  classifyInviteWriteError,
  isInviteLive,
} from './invites.service.js';
import { InviteStatus, invites } from './schema.js';

vi.mock('./invite-token.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./invite-token.js')>();
  return { ...actual, generateInviteToken: vi.fn(actual.generateInviteToken) };
});

/**
 * Item 5 proof: the mocked unit spec can only feed the service errors it
 * wrote itself, so a drift in real Postgres violation text would ship a 500
 * with every test green. These run the service against a real engine
 * (PGlite, committed migrations applied) and assert against genuine
 * violations.
 */
const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);

const db = drizzle(new PGlite(), {
  schema: { users, tracks, cohorts, cohortTracks, invites },
});

const config = {
  APP_PUBLIC_URL: 'http://localhost:3000',
  INVITE_TTL_DAYS: 7,
} as never;

const service = new InvitesService(db as never, config);
const inviter = { id: '', email: 'admin@campus.local', systemRole: 'admin' };

let fixtures: { cohortId: string; cohortTrackId: string };

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(
    sql`truncate invites, cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
  );

  const [admin] = await db
    .insert(users)
    .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
    .returning();
  inviter.id = admin.id;

  const [track] = await db
    .insert(tracks)
    .values({ name: 'Software Engineering', code: 'SE' })
    .returning();
  const [cohort] = await db
    .insert(cohorts)
    .values({ name: 'Cohort 1', code: 'C1', status: CohortStatus.Active })
    .returning();
  const [link] = await db
    .insert(cohortTracks)
    .values({ cohortId: cohort.id, trackId: track.id })
    .returning();

  fixtures = { cohortId: cohort.id, cohortTrackId: link.id };
});

describe('InvitesService against real Postgres', () => {
  it('stores only the hash and returns a link embedding the raw token', async () => {
    const res = await service.create(
      {
        email: 'student@campus.local',
        cohortId: fixtures.cohortId,
        cohortRole: CohortRole.Student,
        cohortTrackId: fixtures.cohortTrackId,
      },
      inviter,
    );

    const [row] = await db
      .select()
      .from(invites)
      .where(sql`${invites.id} = ${res.id}`);
    expect(row.tokenHash).toBe(
      createHash('sha256').update(res.token, 'utf8').digest('hex'),
    );
    expect(row.tokenHash).not.toContain(res.token);
    expect(res.inviteLink).toContain(encodeURIComponent(res.token));
  });

  it('accepts a guest invite { email } end to end', async () => {
    const res = await service.create({ email: 'guest@campus.local' }, inviter);
    expect(res.systemRole).toBe(SystemRole.User);
    expect(res.cohortId).toBeNull();
  });

  it('rejects a second pending invite for the same address (409)', async () => {
    await service.create(
      { email: 'dup@campus.local', systemRole: SystemRole.Admin },
      inviter,
    );
    const err = await service
      .create(
        { email: 'dup@campus.local', systemRole: SystemRole.Admin },
        inviter,
      )
      .catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(InviteConflictException);
    expect((err as InviteConflictException).code).toBe('CONFLICT');
  });

  it('classifies a genuine duplicate-key violation as pending-duplicate', async () => {
    await db.insert(invites).values({
      email: 'raw@campus.local',
      tokenHash: 'hash-one',
      invitedBy: inviter.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const raw = await db
      .insert(invites)
      .values({
        email: 'raw@campus.local',
        tokenHash: 'hash-two',
        invitedBy: inviter.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .catch((caught: unknown) => caught);

    // The assertion that matters: drizzle wraps the driver error, so the
    // outer message is just "Failed query: ..." — SQLSTATE 23505 and the
    // constraint name live on `cause`. The service must match there; if the
    // driver ever changes this shape, this test (not production) breaks first.
    const cause = (raw as { cause?: { code?: unknown; constraint?: unknown } })
      ?.cause;
    expect(cause?.code).toBe('23505');
    expect(cause?.constraint).toBe('invites_email_pending_unique');
    expect(classifyInviteWriteError(raw)).toBe('pending-duplicate');
  });

  it('retries against a genuine token-hash collision', async () => {
    const pinned = 'pinned-raw-token';
    await db.insert(invites).values({
      email: 'first@campus.local',
      tokenHash: hashInviteToken(pinned),
      invitedBy: inviter.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    vi.mocked(generateInviteToken).mockReturnValueOnce(pinned);
    const res = await service.create(
      { email: 'second@campus.local', systemRole: SystemRole.Admin },
      inviter,
    );
    expect(res.token).not.toBe(pinned);
    expect(res.email).toBe('second@campus.local');
  });

  it('re-invites a lapsed address and flips the stale row to expired', async () => {
    await db.insert(invites).values({
      email: 'stale@campus.local',
      tokenHash: 'stale-hash',
      invitedBy: inviter.id,
      expiresAt: new Date(Date.now() - 1_000),
    });

    const res = await service.create(
      { email: 'stale@campus.local', systemRole: SystemRole.Admin },
      inviter,
    );
    expect(res.email).toBe('stale@campus.local');

    const rows = await db
      .select({ status: invites.status })
      .from(invites)
      .where(sql`${invites.email} = 'stale@campus.local'`);
    expect(rows.map((row) => row.status).sort()).toEqual(
      [InviteStatus.Expired, InviteStatus.Pending].sort(),
    );
  });

  it('treats expires_at as the source of truth on read', () => {
    expect(
      isInviteLive({
        status: InviteStatus.Pending,
        expiresAt: new Date(Date.now() + 1_000),
      }),
    ).toBe(true);
    expect(
      isInviteLive({
        status: InviteStatus.Pending,
        expiresAt: new Date(Date.now() - 1_000),
      }),
    ).toBe(false);
    expect(
      isInviteLive({
        status: InviteStatus.Revoked,
        expiresAt: new Date(Date.now() + 1_000),
      }),
    ).toBe(false);
  });

  it('still rejects mismatched cohort/role pairs before touching the DB', async () => {
    await expect(
      service.create({ email: 'x@campus.local', cohortId: fixtures.cohortId }, inviter),
    ).rejects.toBeInstanceOf(InviteInvalidArgumentException);
  });
});
