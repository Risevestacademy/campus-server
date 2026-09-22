import { createHash } from 'node:crypto';

import { CohortRole } from '../cohorts/schema.js';
import { SystemRole } from '../users/schema.js';
import type { CreateInviteDto } from './dto/create-invite.dto.js';
import {
  InviteConflictException,
  InviteInvalidArgumentException,
  InviteNotFoundException,
} from './invites.exceptions.js';
import { InviteStatus } from './schema.js';
import { InvitesService } from './invites.service.js';

const COHORT_ID = '11111111-1111-4111-8111-111111111111';
const TRACK_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const inviter = {
  id: ADMIN_ID,
  email: 'admin@campus.local',
  systemRole: 'admin',
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
  updatedToExpired: string[];
}

function makeDb(state: FakeState) {
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
    update: () => ({
      set: () => ({
        where: ( ) => {
          if (state.pendingInvite) state.updatedToExpired.push(state.pendingInvite.id);
          return Promise.resolve();
        },
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        state.lastInsert = values as Record<string, unknown>;
        return {
          returning: () => {
            if (state.insertError) return Promise.reject(state.insertError);
            return Promise.resolve([
              {
                id: 'new-invite-id',
                email: values['email'],
                cohortId: (values['cohortId'] as string | null) ?? null,
                cohortRole: (values['cohortRole'] as CohortRole | null) ?? null,
                cohortTrackId: (values['cohortTrackId'] as string | null) ?? null,
                mentorshipGroupId:
                  (values['mentorshipGroupId'] as string | null) ?? null,
                systemRole: (values['systemRole'] as SystemRole) ?? SystemRole.User,
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
}

function serviceWith(state: Partial<FakeState> = {}) {
  const full: FakeState = {
    pendingInvite: null,
    cohortExists: true,
    trackRow: { id: TRACK_ID, cohortId: COHORT_ID },
    updatedToExpired: [],
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
    expect(stored).toBe(createHash('sha256').update(res.token, 'utf8').digest('hex'));
    expect(stored).not.toContain(res.token);

    // Shareable link embeds the raw token exactly once.
    expect(res.inviteLink).toBe(
      `http://localhost:3000/invite?token=${encodeURIComponent(res.token)}`,
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

  it.each([
    ['cohortId without cohortRole', { email: 'a@x.local', cohortId: COHORT_ID }],
    ['cohortRole without cohortId', { email: 'a@x.local', cohortRole: CohortRole.Professor }],
    [
      'student without track',
      { email: 'a@x.local', cohortId: COHORT_ID, cohortRole: CohortRole.Student },
    ],
    [
      'scoped track without cohort',
      { email: 'a@x.local', cohortTrackId: TRACK_ID },
    ],
    ['plain user email only', { email: 'a@x.local' }],
    ['plain user email + systemRole user', { email: 'a@x.local', systemRole: SystemRole.User }],
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
      service.create({ email: 'dup@campus.local', systemRole: SystemRole.Admin }, inviter),
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

  it('maps a concurrent-insert unique violation to 409', async () => {
    const { service } = serviceWith({
      insertError: new Error('duplicate key value violates "invites_email_pending_unique"'),
    });
    await expect(service.create(cohortStudentDto(), inviter)).rejects.toBeInstanceOf(
      InviteConflictException,
    );
  });

  it('returns 404 for an unknown cohort', async () => {
    const { service } = serviceWith({ cohortExists: false });
    await expect(service.create(cohortStudentDto(), inviter)).rejects.toBeInstanceOf(
      InviteNotFoundException,
    );
  });

  it('rejects a track that belongs to another cohort', async () => {
    const { service } = serviceWith({
      trackRow: { id: TRACK_ID, cohortId: 'other-cohort' },
    });
    await expect(service.create(cohortStudentDto(), inviter)).rejects.toBeInstanceOf(
      InviteInvalidArgumentException,
    );
  });
});
