import { createHash } from 'node:crypto';

import { auditLog } from '../audit/schema.js';
import { CohortRole } from '../cohorts/schema.js';
import { SystemRole } from '../users/schema.js';
import type { CreateInviteDto } from './dto/create-invite.dto.js';
import {
  InviteAlreadyAcceptedException,
  InviteAlreadyDeclinedException,
  InviteConflictException,
  InviteExpiredException,
  InviteInvalidArgumentException,
  InviteNotFoundException,
  InviteRevokedException,
} from './invites.exceptions.js';
import { generateInviteToken } from './invite-token.js';
import { InviteStatus } from './schema.js';
import { InvitesService, classifyInviteWriteError } from './invites.service.js';

vi.mock('./invite-token.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./invite-token.js')>();
  // Wrap the real generator so tests can script token sequences while the
  // hash helper stays genuine (hash assertions below still prove hash-only
  // storage against whatever token comes out).
  return { ...actual, generateInviteToken: vi.fn(actual.generateInviteToken) };
});

const nextToken = (value: string) =>
  vi.mocked(generateInviteToken).mockReturnValueOnce(value);

/** A real-shaped Postgres unique_violation, not a prose stub. */
function pgUniqueViolation(constraint: string) {
  return Object.assign(
    new Error(`duplicate key value violates unique constraint "${constraint}"`),
    { code: '23505' },
  );
}

const COHORT_ID = '11111111-1111-4111-8111-111111111111';
const TRACK_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const inviter = {
  id: ADMIN_ID,
  email: 'admin@campus.local',
  systemRole: SystemRole.Admin,
};
const config = {
  APP_PUBLIC_URL: 'http://localhost:3000',
  INVITE_TTL_DAYS: 7,
} as never;

interface FakeState {
  pendingInvite?: {
    id: string;
    email: string;
    expiresAt: Date;
    status: typeof InviteStatus.Pending;
  } | null;
  cohortExists: boolean;
  trackRow: { id: string; cohortId: string } | null;
  lastInsert?: Record<string, unknown>;
  insertError?: Error | null;
  /** Shifted one per insert attempt — lets a test fail the first try only. */
  insertErrorQueue?: unknown[];
  insertCalls?: number;
  updatedToExpired: string[];
  auditEntries: Record<string, unknown>[];
}

function makeDb(state: FakeState) {
  const db = {
    // The invite and its audit entry are written together; the fake has no
    // rollback, so a failed insert is simply never followed by an entry.
    transaction: <T>(run: (tx: unknown) => Promise<T>): Promise<T> => run(db),
    query: {
      invites: {
        findFirst: () => Promise.resolve(state.pendingInvite ?? null),
      },
      cohorts: {
        findFirst: () =>
          Promise.resolve(state.cohortExists ? { id: COHORT_ID } : null),
      },
      cohortTracks: {
        findFirst: () => Promise.resolve(state.trackRow),
      },
    },
    // The already-a-member check: nobody here is, so it finds nothing.
    // Behaviour against real rows is in invites.service.db.spec.
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({ limit: () => Promise.resolve([]) }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => {
          if (state.pendingInvite)
            state.updatedToExpired.push(state.pendingInvite.id);
          return Promise.resolve();
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        if (table === auditLog) {
          state.auditEntries.push(values);
          return Promise.resolve();
        }
        state.lastInsert = values as Record<string, unknown>;
        state.insertCalls = (state.insertCalls ?? 0) + 1;
        return {
          returning: () => {
            const queued = state.insertErrorQueue?.shift();
            const err = queued ?? state.insertError;
            if (err) return Promise.reject(err);
            return Promise.resolve([
              {
                id: 'new-invite-id',
                email: values['email'],
                cohortId: (values['cohortId'] as string | null) ?? null,
                cohortRole: (values['cohortRole'] as CohortRole | null) ?? null,
                cohortTrackId:
                  (values['cohortTrackId'] as string | null) ?? null,
                mentorshipGroupId:
                  (values['mentorshipGroupId'] as string | null) ?? null,
                systemRole:
                  (values['systemRole'] as SystemRole) ?? SystemRole.User,
                status: InviteStatus.Pending,
                expiresAt: values['expiresAt'] as Date,
                createdAt: new Date('2026-09-22T12:00:00.000Z'),
              },
            ]);
          },
        };
      },
    }),
  };
  return db;
}

function serviceWith(state: Partial<FakeState> = {}) {
  const full: FakeState = {
    pendingInvite: null,
    cohortExists: true,
    trackRow: { id: TRACK_ID, cohortId: COHORT_ID },
    updatedToExpired: [],
    auditEntries: [],
    ...state,
  };
  const service = new InvitesService(makeDb(full) as never, config);
  return { service, state: full };
}

const cohortStudentDto = (): CreateInviteDto => ({
  email: 'New.Student@Campus.Local',
  cohortId: COHORT_ID,
  cohortRole: CohortRole.Student,
  cohortTrackId: TRACK_ID,
});

describe('InvitesService.create', () => {
  it('creates a cohort invite, hashes the token, returns a shareable link', async () => {
    const { service, state } = serviceWith();
    const res = await service.create(cohortStudentDto(), inviter);

    // Email is normalised; only the hash is persisted.
    expect(res.email).toBe('new.student@campus.local');
    expect(state.lastInsert?.['email']).toBe('new.student@campus.local');
    const stored = state.lastInsert?.['tokenHash'] as string;
    expect(stored).toHaveLength(64);
    expect(stored).toBe(
      createHash('sha256').update(res.token, 'utf8').digest('hex'),
    );
    expect(stored).not.toContain(res.token);

    // Shareable link embeds the raw token exactly once.
    expect(res.inviteLink).toBe(
      `http://localhost:3000/invitation?token=${encodeURIComponent(res.token)}`,
    );
    expect(res.status).toBe(InviteStatus.Pending);
  });

  it('accepts an admin invite { email, systemRole: admin }', async () => {
    const { service } = serviceWith({ cohortExists: false, trackRow: null });
    const res = await service.create(
      { email: 'boss@campus.local', systemRole: SystemRole.Admin },
      inviter,
    );
    expect(res.systemRole).toBe(SystemRole.Admin);
    expect(res.cohortId).toBeNull();
    expect(res.inviteLink).toContain('token=');
  });

  it('accepts an admin invite, the one shape that names no cohort', async () => {
    const { service, state } = serviceWith({
      cohortExists: false,
      trackRow: null,
    });
    const res = await service.create(
      { email: 'Admin@Campus.Local', systemRole: SystemRole.Admin },
      inviter,
    );
    expect(res.email).toBe('admin@campus.local');
    expect(res.systemRole).toBe(SystemRole.Admin);
    expect(res.cohortId).toBeNull();
    expect(res.cohortRole).toBeNull();
    expect(state.lastInsert?.['systemRole']).toBe(SystemRole.Admin);
  });

  /** The shape that stranded people: no cohort to enrol into, no role. */
  it('refuses an invite with no cohort and no admin role', async () => {
    const { service } = serviceWith({ cohortExists: false, trackRow: null });
    await expect(
      service.create({ email: 'nowhere@campus.local' }, inviter),
    ).rejects.toThrow(/may omit a cohort/);
  });

  it.each([
    [
      'cohortId without cohortRole',
      { email: 'a@x.local', cohortId: COHORT_ID },
    ],
    [
      'cohortRole without cohortId',
      { email: 'a@x.local', cohortRole: CohortRole.Professor },
    ],
    [
      'student without track',
      {
        email: 'a@x.local',
        cohortId: COHORT_ID,
        cohortRole: CohortRole.Student,
      },
    ],
    [
      'scoped track without cohort',
      { email: 'a@x.local', cohortTrackId: TRACK_ID },
    ],
  ])('validates the shape: %s -> 400', async (_label, dto) => {
    const { service } = serviceWith();
    await expect(
      service.create(dto as CreateInviteDto, inviter),
    ).rejects.toBeInstanceOf(InviteInvalidArgumentException);
  });

  it('rejects expiresAt in the past', async () => {
    const { service } = serviceWith();
    await expect(
      service.create(
        {
          email: 'a@x.local',
          systemRole: SystemRole.Admin,
          expiresAt: '2020-01-01T00:00:00.000Z',
        },
        inviter,
      ),
    ).rejects.toBeInstanceOf(InviteInvalidArgumentException);
  });

  it('rejects a duplicate pending invite for the same email (409)', async () => {
    const { service } = serviceWith({
      pendingInvite: {
        id: 'open-invite',
        email: 'dup@campus.local',
        expiresAt: new Date(Date.now() + 86_400_000),
        status: InviteStatus.Pending,
      },
    });
    await expect(
      service.create(
        { email: 'dup@campus.local', systemRole: SystemRole.Admin },
        inviter,
      ),
    ).rejects.toBeInstanceOf(InviteConflictException);
  });

  it('allows a re-invite once the old pending invite has lapsed', async () => {
    const { service, state } = serviceWith({
      pendingInvite: {
        id: 'stale-invite',
        email: 'stale@campus.local',
        expiresAt: new Date(Date.now() - 1_000),
        status: InviteStatus.Pending,
      },
    });
    const res = await service.create(
      { email: 'stale@campus.local', systemRole: SystemRole.Admin },
      inviter,
    );
    expect(res.email).toBe('stale@campus.local');
    expect(state.updatedToExpired).toContain('stale-invite');
  });

  it('clamps expiresAt to now + INVITE_TTL_DAYS instead of accepting forever tokens', async () => {
    const { service, state } = serviceWith();
    const before = Date.now();
    await service.create(
      {
        email: 'a@x.local',
        systemRole: SystemRole.Admin,
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      inviter,
    );
    const stored = state.lastInsert?.['expiresAt'] as Date;
    const maxTtl = 7 * 86_400_000;
    expect(stored.getTime()).toBeGreaterThan(before);
    // 1s slack: the service computes "now" a few ms after `before`.
    expect(stored.getTime() - before).toBeLessThanOrEqual(maxTtl + 1_000);
    // And 2099 must be gone — the clamp actually bit.
    expect(stored.getFullYear()).toBeLessThan(2099);
  });

  it('maps a concurrent-insert 23505 on the pending-email index to 409', async () => {
    const { service } = serviceWith({
      insertError: pgUniqueViolation('invites_email_pending_unique'),
    });
    await expect(
      service.create(cohortStudentDto(), inviter),
    ).rejects.toBeInstanceOf(InviteConflictException);
  });

  it('regenerates the token on a 23505 hash collision instead of 409ing', async () => {
    nextToken('colliding-token');
    nextToken('fresh-token');
    const { service, state } = serviceWith({
      insertErrorQueue: [pgUniqueViolation('invites_token_hash_unique')],
    });
    const res = await service.create(
      { email: 'lucky@campus.local', systemRole: SystemRole.Admin },
      inviter,
    );
    expect(res.token).toBe('fresh-token');
    expect(state.insertCalls).toBe(2);
  });

  it('records who created the invite and what it offers, never the address', async () => {
    const { service, state } = serviceWith();
    const res = await service.create(cohortStudentDto(), inviter, 'corr-1');

    expect(state.auditEntries).toEqual([
      expect.objectContaining({
        actorUserId: ADMIN_ID,
        action: 'invite_created',
        subjectType: 'invite',
        subjectId: res.id,
        correlationId: 'corr-1',
        details: expect.objectContaining({
          cohortId: COHORT_ID,
          cohortRole: CohortRole.Student,
          cohortTrackId: TRACK_ID,
          systemRole: SystemRole.User,
        }),
      }),
    ]);
    expect(JSON.stringify(state.auditEntries)).not.toContain('campus.local');
  });

  it('records one entry for an invite that took two attempts to create', async () => {
    nextToken('colliding-token');
    nextToken('fresh-token');
    const { service, state } = serviceWith({
      insertErrorQueue: [pgUniqueViolation('invites_token_hash_unique')],
    });

    await service.create(
      { email: 'lucky@campus.local', systemRole: SystemRole.Admin },
      inviter,
    );

    expect(state.auditEntries).toHaveLength(1);
  });

  it('does not mistake other errors for conflicts — non-23505 rethrows', () => {
    expect(classifyInviteWriteError(new Error('connection reset'))).toBeNull();
    expect(
      classifyInviteWriteError(
        new Error('duplicate key value violates unique constraint "x"'),
      ),
    ).toBeNull();
    expect(
      classifyInviteWriteError(
        pgUniqueViolation('invites_email_pending_unique'),
      ),
    ).toBe('pending-duplicate');
    expect(
      classifyInviteWriteError(pgUniqueViolation('invites_token_hash_unique')),
    ).toBe('token-collision');
  });

  it('returns 404 for an unknown cohort', async () => {
    const { service } = serviceWith({ cohortExists: false });
    await expect(
      service.create(cohortStudentDto(), inviter),
    ).rejects.toBeInstanceOf(InviteNotFoundException);
  });

  it('rejects a track that belongs to another cohort', async () => {
    const { service } = serviceWith({
      trackRow: { id: TRACK_ID, cohortId: 'other-cohort' },
    });
    await expect(
      service.create(cohortStudentDto(), inviter),
    ).rejects.toBeInstanceOf(InviteInvalidArgumentException);
  });
});

describe('InvitesService.resend', () => {
  const LIVE_INVITE = {
    id: 'live-invite',
    email: 'live@campus.local',
    expiresAt: new Date(Date.now() + 86_400_000),
    status: InviteStatus.Pending,
  };

  function stateWithLiveInvite(invite = LIVE_INVITE) {
    return {
      pendingInvite: invite,
      cohortExists: true,
      trackRow: { id: TRACK_ID, cohortId: COHORT_ID },
      updatedToExpired: [] as string[],
      lastUpdateValues: null as Record<string, unknown> | null,
      updateErrorQueue: [] as Error[],
      updateCalls: 0,
    };
  }

  function makeDb(state: ReturnType<typeof stateWithLiveInvite>) {
    let selectCallCount = 0;
    return {
      query: {
        invites: {
          findFirst: () => Promise.resolve(state.pendingInvite ?? null),
        },
        cohorts: {
          findFirst: () =>
            Promise.resolve(state.cohortExists ? { id: COHORT_ID } : null),
        },
        cohortTracks: {
          findFirst: () => Promise.resolve(state.trackRow),
        },
      },
      select: () => {
        selectCallCount++;
        return {
          from: () => ({
            where: () => ({
              limit: () => {
                // First select: return the original invite
                // Second select (after expireLazily): return invite with Expired status if it was lapsed
                if (selectCallCount === 1) {
                  return Promise.resolve(
                    state.pendingInvite ? [state.pendingInvite] : [],
                  );
                }
                // Re-read after expireLazily - return expired status if it was lapsed pending
                const invite = state.pendingInvite;
                if (
                  invite &&
                  invite.status === InviteStatus.Pending &&
                  invite.expiresAt.getTime() <= Date.now()
                ) {
                  return Promise.resolve([
                    { ...invite, status: InviteStatus.Expired },
                  ]);
                }
                return Promise.resolve(invite ? [invite] : []);
              },
            }),
          }),
        };
      },
      update: () => ({
        set: (values: Record<string, unknown>) => {
          state.lastUpdateValues = values;
          state.updateCalls = (state.updateCalls ?? 0) + 1;
          return {
            where: () => {
              const queued = state.updateErrorQueue?.shift();
              if (state.pendingInvite)
                state.updatedToExpired.push(state.pendingInvite.id);
              return {
                returning: () => {
                  if (queued) return Promise.reject(queued);
                  return Promise.resolve([
                    {
                      id: state.pendingInvite?.id,
                      email: state.pendingInvite?.email,
                      cohortId: state.pendingInvite?.cohortId ?? null,
                      cohortRole: state.pendingInvite?.cohortRole ?? null,
                      cohortTrackId: state.pendingInvite?.cohortTrackId ?? null,
                      mentorshipGroupId:
                        state.pendingInvite?.mentorshipGroupId ?? null,
                      systemRole:
                        state.pendingInvite?.systemRole ?? SystemRole.User,
                      status: InviteStatus.Pending,
                      expiresAt: state.pendingInvite?.expiresAt,
                      createdAt: new Date('2026-09-22T12:00:00.000Z'),
                    },
                  ]);
                },
              };
            },
          };
        },
      }),
    };
  }

  function serviceWith(state: ReturnType<typeof stateWithLiveInvite>) {
    const s = new InvitesService(makeDb(state) as never, config);
    return { service: s, state };
  }

  it('returns 404 for unknown invite id', async () => {
    const { service } = serviceWith(stateWithLiveInvite(null));
    await expect(service.resend('unknown')).rejects.toBeInstanceOf(
      InviteNotFoundException,
    );
  });

  it('resends a live pending invite: generates new token, updates hash, returns new link', async () => {
    nextToken('new-token-abc');
    const { service, state } = serviceWith(stateWithLiveInvite());
    const res = await service.resend('live-invite');

    expect(res.token).toBe('new-token-abc');
    expect(res.inviteLink).toBe(
      'http://localhost:3000/invitation?token=new-token-abc',
    );
    expect(state.lastUpdateValues).toEqual({
      tokenHash: createHash('sha256')
        .update('new-token-abc', 'utf8')
        .digest('hex'),
    });
    expect(state.updateCalls).toBe(1);
  });

  it('retries once on token hash collision', async () => {
    nextToken('colliding-token');
    nextToken('fresh-token');
    const { service, state } = serviceWith({
      ...stateWithLiveInvite(),
      updateErrorQueue: [pgUniqueViolation('invites_token_hash_unique')],
    });
    const res = await service.resend('live-invite');

    expect(res.token).toBe('fresh-token');
    expect(state.updateCalls).toBe(2);
  });

  it('reports expired (403) for a lapsed pending invite and materialises it', async () => {
    const { service, state } = serviceWith(
      stateWithLiveInvite({
        id: 'lapsed-invite',
        email: 'lapsed@campus.local',
        expiresAt: new Date(Date.now() - 1_000),
        status: InviteStatus.Pending,
      }),
    );
    await expect(service.resend('lapsed-invite')).rejects.toBeInstanceOf(
      InviteExpiredException,
    );
    expect(state.updatedToExpired).toContain('lapsed-invite');
  });

  it('reports expired (403) for an already-expired invite', async () => {
    const { service } = serviceWith(
      stateWithLiveInvite({
        id: 'expired-invite',
        email: 'expired@campus.local',
        expiresAt: new Date(Date.now() - 1_000),
        status: InviteStatus.Expired,
      }),
    );
    await expect(service.resend('expired-invite')).rejects.toBeInstanceOf(
      InviteExpiredException,
    );
  });

  it.each([
    ['accepted', InviteStatus.Accepted, InviteAlreadyAcceptedException],
    ['declined', InviteStatus.Declined, InviteAlreadyDeclinedException],
    ['revoked', InviteStatus.Revoked, InviteRevokedException],
  ])('reports 409 for %s invite', async (_label, status, ExceptionClass) => {
    const { service } = serviceWith(
      stateWithLiveInvite({
        id: 'settled-invite',
        email: 'settled@campus.local',
        expiresAt: new Date(Date.now() + 86_400_000),
        status,
      }),
    );
    await expect(service.resend('settled-invite')).rejects.toBeInstanceOf(
      ExceptionClass,
    );
  });
});
