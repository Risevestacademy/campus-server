import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import type {
  EmailSender,
  OutgoingEmail,
} from '../../infra/email/email-sender.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { AccessDeniedException } from '../../shared/exceptions/index.js';
import { AuditAction, auditLog } from '../audit/schema.js';
import { refreshTokens } from '../auth/schema.js';
import { SessionIssuer } from '../auth/session-issuer.js';
import { googleCalendarGrants } from '../calendar/schema.js';
import {
  callChatAttachments,
  sessions as callSessions,
} from '../calls/schema.js';
import {
  CohortRole,
  StudentStatus,
  cohortMembers,
  cohortTracks,
  cohorts,
} from '../cohorts/schema.js';
import { DeskReleaseReason, deskClaims, desks } from '../desks/schema.js';
import {
  FeedbackType,
  feedback,
  feedbackAttachments,
} from '../feedback/schema.js';
import { InviteStatus, invites } from '../invites/schema.js';
import {
  AudioMode,
  SpaceAccess,
  maps,
  spaceMemberships,
  spaces,
} from '../maps/schema.js';
import { MediaService } from '../media/media.service.js';
import { MediaBucket, MediaKind, MediaStatus, media } from '../media/schema.js';
import {
  mentorshipGroupStudents,
  mentorshipGroups,
} from '../mentorship-groups/schema.js';
import { NoticeScope, noticeAttachments, notices } from '../notices/schema.js';
import {
  NotificationKind,
  NotificationReferenceType,
  notifications,
} from '../notifications/schema.js';
import { roomLinkPasses, roomLinks } from '../room-links/schema.js';
import { tracks } from '../tracks/schema.js';
import { AccountDeletionService } from './account-deletion.service.js';
import {
  AnalyticsConsent,
  DELETED_DISPLAY_NAME,
  SystemRole,
  UserStatus,
  deletedEmailOf,
  users,
} from './schema.js';
import { ProfileService } from './profile/profile.service.js';
import { UserRolesService } from './user-roles.service.js';
import { UserStatusService } from './user-status.service.js';
import {
  AccountStatusLockedException,
  ProfileNotFoundException,
  SystemRoleLockedException,
  UserNotFoundException,
} from './users.exceptions.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);
const db = drizzle(new PGlite(), { schema: { users, auditLog } });
const quiet = { setContext() {}, warn() {}, error() {}, info() {} };
const sessions = new SessionIssuer(
  {} as never,
  db as never,
  {} as never,
  {} as never,
);
const mediaService = new MediaService(
  db as never,
  null,
  { register() {} } as never,
  quiet as never,
);

let sent: OutgoingEmail[];
let sendResult: () => Promise<
  { ok: true; id: string } | { ok: false; reason: string }
>;
const sender: EmailSender = {
  enabled: true,
  send: (email) => {
    sent.push(email);
    return sendResult();
  },
};
const service = new AccountDeletionService(
  db as never,
  sessions,
  mediaService,
  sender,
  quiet as never,
);
const status = new UserStatusService(db as never, sessions);
const roles = new UserRolesService(db as never, sessions);
const profiles = new ProfileService(db as never, mediaService);

const person = async (
  email: string,
  systemRole = SystemRole.User,
  extra: Partial<typeof users.$inferInsert> = {},
) => {
  const [row] = await db
    .insert(users)
    .values({ email, systemRole, ...extra })
    .returning();
  return row;
};
const actorOf = (row: typeof users.$inferSelect): AuthenticatedUser => ({
  id: row.id,
  email: row.email,
  systemRole: row.systemRole,
});
const rowOf = async (id: string) => {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row;
};

let admin: typeof users.$inferSelect;
let cohortId: string;
let cohortTrackId: string;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  sent = [];
  sendResult = () => Promise.resolve({ ok: true, id: 'email-1' });
  await db.execute(
    sql`truncate audit_log, refresh_tokens, notifications, invites, desk_claims, desks, space_memberships, room_link_passes, room_links, call_chat_attachments, sessions, notice_attachments, notices, feedback_attachments, feedback, google_calendar_grants, spaces, maps, media, mentorship_group_students, mentorship_groups, cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
  );
  admin = await person('admin@campus.local', SystemRole.Admin);
  const [track] = await db
    .insert(tracks)
    .values({ name: 'Track One', code: 'T1' })
    .returning();
  const [cohort] = await db
    .insert(cohorts)
    .values({ name: 'Cohort One', code: 'C1' })
    .returning();
  const [cohortTrack] = await db
    .insert(cohortTracks)
    .values({ cohortId: cohort.id, trackId: track.id })
    .returning();
  cohortId = cohort.id;
  cohortTrackId = cohortTrack.id;
});

describe('AccountDeletionService.delete', () => {
  it('strips the account, frees its email and records who deleted it', async () => {
    const ada = await person('ada@campus.local', SystemRole.User, {
      providerId: 'google-ada',
      firstName: 'Ada',
      lastName: 'Lovelace',
      displayName: 'Ada L',
      phone: '+2340000000',
      bio: 'Counting engines',
      googlePictureUrl: 'https://example.com/ada.png',
      spriteKey: 'sprite-1',
    });

    await service.delete(actorOf(admin), ada.id, 'corr-1');

    const row = await rowOf(ada.id);
    expect(row).toMatchObject({
      status: UserStatus.Deleted,
      email: deletedEmailOf(ada.id),
      providerId: null,
      firstName: null,
      lastName: null,
      displayName: DELETED_DISPLAY_NAME,
      phone: null,
      bio: null,
      googlePictureUrl: null,
      spriteKey: null,
      systemRole: SystemRole.User,
      analyticsErasedAt: null,
    });
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(row.sessionEpoch).toBe(1);

    const [entry] = await db.select().from(auditLog);
    expect(entry).toMatchObject({
      actorUserId: admin.id,
      action: AuditAction.AccountDeleted,
      subjectId: ada.id,
      correlationId: 'corr-1',
      details: {
        actorRole: SystemRole.Admin,
        systemRole: SystemRole.User,
        endedMembershipIds: [],
      },
    });

    const again = await person('ada@campus.local');
    expect(again.id).not.toBe(ada.id);
  });

  it('ends their sessions', async () => {
    const ada = await person('ada@campus.local');
    await db.insert(refreshTokens).values({
      userId: ada.id,
      familyId: '77777777-7777-4777-8777-777777777777',
      tokenHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    await service.delete(actorOf(admin), ada.id);

    const tokens = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, ada.id));
    expect(tokens.every((token) => token.revokedAt !== null)).toBe(true);
  });

  it('ends live memberships, leaves pods and wipes end reasons', async () => {
    const ada = await person('ada@campus.local');
    const mentor = await person('mentor@campus.local');
    const [membership, mentorMembership] = await db
      .insert(cohortMembers)
      .values([
        {
          cohortId,
          userId: ada.id,
          role: CohortRole.Student,
          status: StudentStatus.Active,
          cohortTrackId,
        },
        { cohortId, userId: mentor.id, role: CohortRole.Mentor },
      ])
      .returning();
    const [group] = await db
      .insert(mentorshipGroups)
      .values({ cohortId, mentorMemberId: mentorMembership.id, name: 'Pod' })
      .returning();
    await db.insert(mentorshipGroupStudents).values({
      mentorshipGroupId: group.id,
      cohortId,
      cohortMemberId: membership.id,
    });

    await service.delete(actorOf(admin), ada.id);

    const [ended] = await db
      .select()
      .from(cohortMembers)
      .where(eq(cohortMembers.id, membership.id));
    expect(ended.leftAt).toBeInstanceOf(Date);
    expect(ended.dismissalReason).toBeNull();
    expect(await db.select().from(mentorshipGroupStudents)).toEqual([]);
    const [entry] = await db.select().from(auditLog);
    expect(entry.details).toMatchObject({
      endedMembershipIds: [membership.id],
    });
  });

  it('refuses a mentor who leads a mentorship group', async () => {
    const mentor = await person('mentor@campus.local');
    const [membership] = await db
      .insert(cohortMembers)
      .values({ cohortId, userId: mentor.id, role: CohortRole.Mentor })
      .returning();
    await db
      .insert(mentorshipGroups)
      .values({ cohortId, mentorMemberId: membership.id, name: 'Pod' });

    await expect(
      service.delete(actorOf(admin), mentor.id),
    ).rejects.toBeInstanceOf(AccountStatusLockedException);
    expect((await rowOf(mentor.id)).status).toBe(UserStatus.Active);
  });

  it('revokes pending invites to their address and deletes their notifications', async () => {
    const ada = await person('ada@campus.local');
    await db.insert(invites).values({
      email: 'ada@campus.local',
      tokenHash: 'hash-one',
      invitedBy: admin.id,
      systemRole: SystemRole.Admin,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await db.insert(notifications).values({
      recipientId: ada.id,
      kind: NotificationKind.NoticePosted,
      referenceType: NotificationReferenceType.Notice,
      referenceId: '11111111-1111-4111-8111-111111111111',
    });

    await service.delete(actorOf(admin), ada.id);

    const [invite] = await db.select().from(invites);
    expect(invite).toMatchObject({
      status: InviteStatus.Revoked,
      revokedBy: admin.id,
    });
    expect(await db.select().from(notifications)).toEqual([]);
  });

  it('releases what they uploaded', async () => {
    const ada = await person('ada@campus.local');
    const now = new Date();
    const [avatar] = await db
      .insert(media)
      .values({
        kind: MediaKind.Avatar,
        bucket: MediaBucket.Public,
        uploadKey: 'incoming/avatar',
        key: 'avatars/ada/1.png',
        uploadedBy: ada.id,
        contentType: 'image/png',
        sizeBytes: 10,
        status: MediaStatus.Ready,
        verifiedAt: now,
        readyAt: now,
      })
      .returning();
    await db
      .update(users)
      .set({ avatarMediaId: avatar.id })
      .where(eq(users.id, ada.id));

    await service.delete(actorOf(admin), ada.id, undefined, now);

    const [released] = await db.select().from(media);
    expect(released.status).toBe(MediaStatus.Removed);
    expect(released.purgeAfter).toEqual(now);
    expect((await rowOf(ada.id)).avatarMediaId).toBeNull();
  });

  it('emails the person at their old address', async () => {
    const ada = await person('ada@campus.local', SystemRole.User, {
      firstName: 'Ada',
    });

    await service.delete(actorOf(admin), ada.id);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'ada@campus.local',
      subject: 'Your Campus account has been deleted',
      idempotencyKey: `account-deleted/${ada.id}`,
    });
    expect(sent[0].text).toContain('Hi Ada,');
  });

  it('still deletes when the email cannot be sent', async () => {
    const ada = await person('ada@campus.local');
    sendResult = () => Promise.reject(new Error('provider down'));

    await service.delete(actorOf(admin), ada.id);

    expect((await rowOf(ada.id)).status).toBe(UserStatus.Deleted);
  });

  it('refuses the caller themselves', async () => {
    await expect(
      service.delete(actorOf(admin), admin.id),
    ).rejects.toBeInstanceOf(AccountStatusLockedException);
  });

  it('refuses an account already deleted', async () => {
    const ada = await person('ada@campus.local');
    await service.delete(actorOf(admin), ada.id);

    await expect(service.delete(actorOf(admin), ada.id)).rejects.toBeInstanceOf(
      AccountStatusLockedException,
    );
    expect(sent).toHaveLength(1);
  });

  it('refuses an unknown account', async () => {
    await expect(
      service.delete(actorOf(admin), '99999999-9999-4999-8999-999999999999'),
    ).rejects.toBeInstanceOf(UserNotFoundException);
  });

  it('lets only a super admin delete a super admin', async () => {
    const root = await person('root@campus.local', SystemRole.SuperAdmin);
    const other = await person('other@campus.local', SystemRole.SuperAdmin);

    await expect(
      service.delete(actorOf(admin), root.id),
    ).rejects.toBeInstanceOf(AccessDeniedException);

    await service.delete(actorOf(other), root.id);
    expect((await rowOf(root.id)).status).toBe(UserStatus.Deleted);
  });

  it('refuses a plain user', async () => {
    const ada = await person('ada@campus.local');
    const bob = await person('bob@campus.local');

    await expect(service.delete(actorOf(ada), bob.id)).rejects.toBeInstanceOf(
      AccessDeniedException,
    );
  });

  it('cannot be undone by reinstating or suspending', async () => {
    const ada = await person('ada@campus.local');
    await service.delete(actorOf(admin), ada.id);

    await expect(
      status.reinstate(actorOf(admin), ada.id),
    ).rejects.toBeInstanceOf(AccountStatusLockedException);
    await expect(status.suspend(actorOf(admin), ada.id)).rejects.toBeInstanceOf(
      AccountStatusLockedException,
    );
    expect((await rowOf(ada.id)).status).toBe(UserStatus.Deleted);
  });

  it('ends desk claims, space grants, room-link passes and the calendar grant', async () => {
    const ada = await person('ada@campus.local');
    const [map] = await db
      .insert(maps)
      .values({ key: 'campus', name: 'Campus', isEntry: true })
      .returning();
    const [space] = await db
      .insert(spaces)
      .values({
        mapId: map.id,
        key: 'lecture',
        name: 'Lecture',
        audioMode: AudioMode.Boundary,
        access: SpaceAccess.Normal,
      })
      .returning();
    const [desk] = await db
      .insert(desks)
      .values({ mapId: map.id, key: 'desk_a' })
      .returning();
    await db
      .insert(deskClaims)
      .values({ deskId: desk.id, cohortId, userId: ada.id });
    await db
      .insert(spaceMemberships)
      .values({ spaceId: space.id, userId: ada.id });
    const [link] = await db
      .insert(roomLinks)
      .values({
        code: 'codexxxxxx',
        cohortId,
        spaceId: space.id,
        title: 'Class',
        createdBy: admin.id,
      })
      .returning();
    await db
      .insert(roomLinkPasses)
      .values({ roomLinkId: link.id, userId: ada.id });
    await db
      .insert(googleCalendarGrants)
      .values({ userId: ada.id, sealedRefreshToken: 'sealed' });
    const now = new Date();

    await service.delete(actorOf(admin), ada.id, undefined, now);

    const [claim] = await db.select().from(deskClaims);
    expect(claim).toMatchObject({
      releasedAt: now,
      releaseReason: DeskReleaseReason.AccountDeleted,
    });
    expect(await db.select().from(spaceMemberships)).toEqual([]);
    expect(await db.select().from(roomLinkPasses)).toEqual([]);
    const [grant] = await db.select().from(googleCalendarGrants);
    expect(grant.revokeRequestedAt).toEqual(now);
  });

  it('takes their uploads off notices, feedback and call chat', async () => {
    const ada = await person('ada@campus.local');
    const now = new Date();
    const upload = async (key: string, kind: MediaKind) => {
      const [row] = await db
        .insert(media)
        .values({
          kind,
          bucket: MediaBucket.Private,
          uploadKey: `incoming/${key}`,
          key: `attachments/${key}`,
          uploadedBy: ada.id,
          contentType: 'application/pdf',
          sizeBytes: 10,
          status: MediaStatus.Ready,
          verifiedAt: now,
          readyAt: now,
        })
        .returning();
      return row.id;
    };
    const [map] = await db
      .insert(maps)
      .values({ key: 'campus', name: 'Campus', isEntry: true })
      .returning();
    const [space] = await db
      .insert(spaces)
      .values({
        mapId: map.id,
        key: 'lecture',
        name: 'Lecture',
        audioMode: AudioMode.Boundary,
        access: SpaceAccess.Normal,
      })
      .returning();
    const [notice] = await db
      .insert(notices)
      .values({
        authorId: admin.id,
        scope: NoticeScope.Campus,
        title: 'Notice',
        body: 'Body',
      })
      .returning();
    const [report] = await db
      .insert(feedback)
      .values({
        type: FeedbackType.Bug,
        title: 'Title',
        details: 'Details',
        submittedBy: ada.id,
      })
      .returning();
    const [call] = await db
      .insert(callSessions)
      .values({
        cohortId,
        spaceId: space.id,
        providerRoomId: 'room-1',
        openedAt: now,
      })
      .returning();
    await db.insert(noticeAttachments).values({
      noticeId: notice.id,
      mediaId: await upload('notice', MediaKind.NoticeAttachment),
      position: 0,
    });
    await db.insert(feedbackAttachments).values({
      feedbackId: report.id,
      mediaId: await upload('feedback', MediaKind.FeedbackAttachment),
      position: 0,
    });
    await db.insert(callChatAttachments).values({
      sessionId: call.id,
      mediaId: await upload('chat', MediaKind.CallChatAttachment),
    } as typeof callChatAttachments.$inferInsert);

    await service.delete(actorOf(admin), ada.id, undefined, now);

    expect(await db.select().from(noticeAttachments)).toEqual([]);
    expect(await db.select().from(feedbackAttachments)).toEqual([]);
    expect(await db.select().from(callChatAttachments)).toEqual([]);
    const rows = await db.select().from(media);
    expect(rows.map((row) => row.status)).toEqual([
      MediaStatus.Removed,
      MediaStatus.Removed,
      MediaStatus.Removed,
    ]);
    expect((await db.select().from(feedback))[0].title).toBe('Title');
  });

  it('takes the old address and flag text off every invite', async () => {
    const ada = await person('ada@campus.local');
    await db.insert(invites).values({
      email: 'ada@campus.local',
      tokenHash: 'hash-accepted',
      invitedBy: admin.id,
      systemRole: SystemRole.Admin,
      status: InviteStatus.Accepted,
      flaggedAt: new Date(),
      flagMessage: 'Ada here, my name is spelt wrong',
      expiresAt: new Date(Date.now() + 86_400_000),
    } as typeof invites.$inferInsert);

    await service.delete(actorOf(admin), ada.id);

    const [invite] = await db.select().from(invites);
    expect(invite).toMatchObject({
      email: deletedEmailOf(ada.id),
      status: InviteStatus.Accepted,
      flaggedAt: null,
      flagMessage: null,
    });
  });

  it('refuses a caller who is no longer active', async () => {
    const other = await person('other@campus.local', SystemRole.Admin, {
      status: UserStatus.Suspended,
    });
    const ada = await person('ada@campus.local');

    await expect(service.delete(actorOf(other), ada.id)).rejects.toBeInstanceOf(
      AccessDeniedException,
    );
    expect((await rowOf(ada.id)).status).toBe(UserStatus.Active);
  });

  it('writes no audit entry when it refuses', async () => {
    const ada = await person('ada@campus.local');
    const root = await person('root@campus.local', SystemRole.SuperAdmin);
    const mentor = await person('mentor@campus.local');
    const [membership] = await db
      .insert(cohortMembers)
      .values({ cohortId, userId: mentor.id, role: CohortRole.Mentor })
      .returning();
    await db
      .insert(mentorshipGroups)
      .values({ cohortId, mentorMemberId: membership.id, name: 'Pod' });

    const refusals = [
      service.delete(actorOf(admin), admin.id),
      service.delete(actorOf(ada), admin.id),
      service.delete(actorOf(admin), root.id),
      service.delete(actorOf(admin), mentor.id),
      service.delete(actorOf(admin), '99999999-9999-4999-8999-999999999999'),
    ];
    for (const refusal of refusals) {
      await expect(refusal).rejects.toThrow();
    }

    expect(await db.select().from(auditLog)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('refuses a role change on a deleted account', async () => {
    const root = await person('root@campus.local', SystemRole.SuperAdmin);
    const ada = await person('ada@campus.local');
    await service.delete(actorOf(admin), ada.id);

    await expect(
      roles.setSystemRole(actorOf(root), ada.id, SystemRole.Admin),
    ).rejects.toBeInstanceOf(SystemRoleLockedException);
    expect((await rowOf(ada.id)).systemRole).toBe(SystemRole.User);
  });

  it('keeps a profile write that was already past the guard off the deleted row', async () => {
    const ada = await person('ada@campus.local', SystemRole.User, {
      firstName: 'Ada',
    });
    await service.delete(actorOf(admin), ada.id);

    await expect(
      profiles.updateOwn(ada.id, { firstName: 'Ada', bio: 'Back again' }),
    ).rejects.toBeInstanceOf(ProfileNotFoundException);
    await expect(
      profiles.setAnalyticsConsent(ada.id, AnalyticsConsent.Granted),
    ).rejects.toBeInstanceOf(ProfileNotFoundException);
    await expect(profiles.removeAvatar(ada.id)).rejects.toBeInstanceOf(
      ProfileNotFoundException,
    );
    expect(await rowOf(ada.id)).toMatchObject({
      firstName: null,
      bio: null,
      analyticsConsent: null,
    });
  });
});
