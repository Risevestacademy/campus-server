import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, inArray, ne, sql } from 'drizzle-orm';

import {
  DRIZZLE,
  type Db,
  type DbExecutor,
  type Tx,
} from '../../infra/database/database.constants.js';
import { isCheckViolation } from '../../infra/database/check-violation.js';
import { isForeignKeyViolation } from '../../infra/database/foreign-key-violation.js';
import { isUniqueViolation } from '../../infra/database/unique-violation.js';
import type { PaginatedResponseDto } from '../../shared/dto/paginated-response.dto.js';
import type { PaginationQueryDto } from '../../shared/dto/pagination-query.dto.js';
import {
  type AuditContext,
  changedFields,
  writeAuditEntry,
} from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType } from '../audit/schema.js';
import { assertCohortExists } from '../cohorts/assert-cohort-exists.js';
import { isLiveMembership } from '../cohorts/cohort-members.service.js';
import { CohortMemberNotFoundException } from '../cohorts/cohorts.exceptions.js';
import { CohortRole, StudentStatus, cohortMembers } from '../cohorts/schema.js';
import { InviteStatus, invites } from '../invites/schema.js';
import { releaseGroupGrants } from '../maps/space-memberships.service.js';
import { users } from '../users/schema.js';
import type { ChangeMentorDto } from './dto/change-mentor.dto.js';
import type { CreateMentorshipGroupDto } from './dto/create-mentorship-group.dto.js';
import type {
  MentorshipGroupResponseDto,
  MentorshipGroupStudentDto,
} from './dto/mentorship-group-response.dto.js';
import type { UpdateMentorshipGroupDto } from './dto/update-mentorship-group.dto.js';
import {
  MentorshipGroupConflictException,
  MentorshipGroupInvalidArgumentException,
  MentorshipGroupNotFoundException,
} from './mentorship-groups.exceptions.js';
import {
  mentorshipGroupStudents,
  mentorshipGroups,
  type MentorshipGroup,
} from './schema.js';

/** The fields a PATCH may move, and so what an update entry compares. */
const EDITABLE_FIELDS = ['name', 'description'] as const;

const userFields = {
  id: users.id,
  email: users.email,
  firstName: users.firstName,
  lastName: users.lastName,
  displayName: users.displayName,
  avatarUrl: users.avatarUrl,
  status: users.status,
};

type GroupRow = typeof mentorshipGroups.$inferSelect;

/**
 * The admin's mentorship pods: one mentor and a set of students inside one
 * cohort. Every write runs in one transaction with its audit entry, and every
 * reference is checked against the membership row it names, not just the user.
 */
@Injectable()
export class MentorshipGroupsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async create(
    cohortId: string,
    dto: CreateMentorshipGroupDto,
    audit: AuditContext,
  ): Promise<MentorshipGroupResponseDto> {
    try {
      const row = await this.db.transaction(async (tx) => {
        await assertCohortExists(tx, cohortId);
        await this.assertMentor(tx, cohortId, dto.mentorMemberId);

        const [row] = await tx
          .insert(mentorshipGroups)
          .values({
            cohortId,
            mentorMemberId: dto.mentorMemberId,
            name: dto.name,
            description: dto.description ?? null,
          })
          .returning();

        await writeAuditEntry(tx, {
          ...audit,
          action: AuditAction.MentorshipGroupCreated,
          subject: { type: AuditSubjectType.MentorshipGroup, id: row.id },
          details: {
            cohortId,
            name: row.name,
            description: row.description,
            mentorMemberId: row.mentorMemberId,
          },
        });
        return row;
      });

      return (await this.loadGroups(this.db, [row]))[0];
    } catch (err) {
      throw this.translateWriteError(err, {
        cohortId,
        mentorMemberId: dto.mentorMemberId,
      });
    }
  }

  async list(
    cohortId: string,
    query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<MentorshipGroupResponseDto>> {
    await assertCohortExists(this.db, cohortId);

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(mentorshipGroups)
        .where(eq(mentorshipGroups.cohortId, cohortId))
        .orderBy(
          asc(sql`lower(${mentorshipGroups.name})`),
          asc(mentorshipGroups.id),
        )
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      this.db
        .select({ total: count() })
        .from(mentorshipGroups)
        .where(eq(mentorshipGroups.cohortId, cohortId)),
    ]);

    return {
      items: await this.loadGroups(this.db, rows),
      meta: {
        page: query.page,
        perPage: query.perPage,
        total,
        totalPages: Math.ceil(total / query.perPage),
      },
    };
  }

  async get(
    cohortId: string,
    groupId: string,
  ): Promise<MentorshipGroupResponseDto> {
    const group = await this.findGroup(this.db, cohortId, groupId);
    return (await this.loadGroups(this.db, [group]))[0];
  }

  async update(
    cohortId: string,
    groupId: string,
    dto: UpdateMentorshipGroupDto,
    audit: AuditContext,
  ): Promise<MentorshipGroupResponseDto> {
    if (dto.name === undefined && dto.description === undefined) {
      return this.get(cohortId, groupId);
    }

    try {
      const row = await this.db.transaction(async (tx) => {
        const existing = await this.findGroup(tx, cohortId, groupId, true);

        const [row] = await tx
          .update(mentorshipGroups)
          .set({
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.description !== undefined
              ? { description: dto.description }
              : {}),
          })
          .where(eq(mentorshipGroups.id, groupId))
          .returning();

        const changes = changedFields(existing, row, EDITABLE_FIELDS);
        if (Object.keys(changes).length > 0) {
          await writeAuditEntry(tx, {
            ...audit,
            action: AuditAction.MentorshipGroupUpdated,
            subject: { type: AuditSubjectType.MentorshipGroup, id: groupId },
            details: { cohortId, changes },
          });
        }
        return row;
      });

      return (await this.loadGroups(this.db, [row]))[0];
    } catch (err) {
      throw this.translateWriteError(err, { cohortId });
    }
  }

  async changeMentor(
    cohortId: string,
    groupId: string,
    dto: ChangeMentorDto,
    audit: AuditContext,
  ): Promise<MentorshipGroupResponseDto> {
    try {
      const row = await this.db.transaction(async (tx) => {
        const existing = await this.findGroup(tx, cohortId, groupId, true);
        await this.assertMentor(tx, cohortId, dto.mentorMemberId);

        const [row] = await tx
          .update(mentorshipGroups)
          .set({ mentorMemberId: dto.mentorMemberId })
          .where(eq(mentorshipGroups.id, groupId))
          .returning();

        if (existing.mentorMemberId !== dto.mentorMemberId) {
          await writeAuditEntry(tx, {
            ...audit,
            action: AuditAction.MentorshipGroupMentorChanged,
            subject: { type: AuditSubjectType.MentorshipGroup, id: groupId },
            details: {
              cohortId,
              from: existing.mentorMemberId,
              to: dto.mentorMemberId,
            },
          });
        }
        return row;
      });

      return (await this.loadGroups(this.db, [row]))[0];
    } catch (err) {
      throw this.translateWriteError(err, {
        cohortId,
        mentorMemberId: dto.mentorMemberId,
      });
    }
  }

  async addStudent(
    cohortId: string,
    groupId: string,
    cohortMemberId: string,
    audit: AuditContext,
  ): Promise<MentorshipGroupResponseDto> {
    try {
      const group = await this.db.transaction(async (tx) => {
        const group = await this.findGroup(tx, cohortId, groupId, true);
        await this.assertStudent(tx, cohortId, cohortMemberId);

        await tx.insert(mentorshipGroupStudents).values({
          mentorshipGroupId: groupId,
          cohortId,
          cohortMemberId,
        });
        await writeAuditEntry(tx, {
          ...audit,
          action: AuditAction.MentorshipGroupStudentAdded,
          subject: { type: AuditSubjectType.MentorshipGroup, id: groupId },
          details: { cohortId, cohortMemberId },
        });
        return group;
      });

      return (await this.loadGroups(this.db, [group]))[0];
    } catch (err) {
      throw this.translateWriteError(err, {
        cohortId,
        cohortMemberId,
      });
    }
  }

  async removeStudent(
    cohortId: string,
    groupId: string,
    cohortMemberId: string,
    audit: AuditContext,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.findGroup(tx, cohortId, groupId, true);

      const [row] = await tx
        .delete(mentorshipGroupStudents)
        .where(
          and(
            eq(mentorshipGroupStudents.mentorshipGroupId, groupId),
            eq(mentorshipGroupStudents.cohortId, cohortId),
            eq(mentorshipGroupStudents.cohortMemberId, cohortMemberId),
          ),
        )
        .returning();

      if (!row) {
        throw new MentorshipGroupNotFoundException(
          `Student ${cohortMemberId} is not in mentorship group ${groupId}`,
          { cohortId, groupId, cohortMemberId },
        );
      }

      await writeAuditEntry(tx, {
        ...audit,
        action: AuditAction.MentorshipGroupStudentRemoved,
        subject: { type: AuditSubjectType.MentorshipGroup, id: groupId },
        details: { cohortId, cohortMemberId },
      });
    });
  }

  async remove(
    cohortId: string,
    groupId: string,
    audit: AuditContext,
    now: Date = new Date(),
  ): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        const group = await this.findGroup(tx, cohortId, groupId, true);

        // A pending invite is still an offer, so the pod has to stay while it
        // can be accepted. Lapsed does not matter: a resend can bring the
        // same pending row back, so the status is what is checked.
        const [pending] = await tx
          .select({ id: invites.id })
          .from(invites)
          .where(
            and(
              eq(invites.mentorshipGroupId, groupId),
              eq(invites.status, InviteStatus.Pending),
            ),
          )
          .limit(1);
        if (pending) {
          throw new MentorshipGroupConflictException(
            'Mentorship group cannot be deleted while a pending invite names it',
            { cohortId, groupId, inviteId: pending.id },
          );
        }

        // What a space's list says about this group: a live entry keeps the
        // group, and every ended one goes with it, as a detached track's do.
        // The group row is locked above, and a grant holds it with
        // `key share`, so no entry can appear between this and the delete;
        // the read locks the entries it finds, so an end in flight is waited
        // for, not raced.
        const grants = await releaseGroupGrants(tx, groupId, now);
        if (!grants.released) {
          throw new MentorshipGroupConflictException(
            'Mentorship group cannot be deleted while a space’s list names it',
            { cohortId, groupId, spaceIds: grants.standingSpaceIds },
          );
        }

        // Settled invites keep their row and every other column; only the
        // pointer to the group goes, so the history stays readable. Setting
        // updated_at to itself stops $onUpdate rewriting a settled row.
        await tx
          .update(invites)
          .set({
            mentorshipGroupId: null,
            updatedAt: invites.updatedAt,
          })
          .where(
            and(
              eq(invites.mentorshipGroupId, groupId),
              ne(invites.status, InviteStatus.Pending),
            ),
          );

        // The student links are not cascaded: a teacher deleting a pod should
        // not require emptying it first, and the audit entry below records the
        // group that went with them.
        await tx
          .delete(mentorshipGroupStudents)
          .where(eq(mentorshipGroupStudents.mentorshipGroupId, groupId));
        await tx
          .delete(mentorshipGroups)
          .where(eq(mentorshipGroups.id, groupId));

        await writeAuditEntry(tx, {
          ...audit,
          action: AuditAction.MentorshipGroupDeleted,
          subject: { type: AuditSubjectType.MentorshipGroup, id: groupId },
          details: {
            cohortId,
            name: group.name,
            description: group.description,
            mentorMemberId: group.mentorMemberId,
            clearedSpaceMembershipIds: grants.clearedIds,
          },
        });
      });
    } catch (err) {
      // A pending invite inserted between the check and the delete is the
      // only thing the FKs can still refuse: a grant holds the group's row
      // with `key share`, which the lock above waits behind. Name that
      // constraint, so any other FK failure — a bug in the clear above, or
      // a link added later — surfaces as itself instead of this message.
      if (isForeignKeyViolation(err, 'invites_mentorship_group_cohort_fk')) {
        throw new MentorshipGroupConflictException(
          'Mentorship group cannot be deleted while a pending invite names it',
          { cohortId, groupId },
        );
      }
      throw err;
    }
  }

  /**
   * The people of each group, in one query per role rather than one per
   * group. Students are restricted to live memberships: a student who left,
   * was dismissed, or whose place otherwise ended no longer belongs in a pod.
   */
  private async loadGroups(
    executor: DbExecutor,
    rows: GroupRow[],
  ): Promise<MentorshipGroupResponseDto[]> {
    if (rows.length === 0) return [];

    const groupIds = rows.map((row) => row.id);
    const mentorIds = rows.map((row) => row.mentorMemberId);
    const now = new Date();

    const [mentors, students] = await Promise.all([
      executor
        .select({ cohortMemberId: cohortMembers.id, user: userFields })
        .from(cohortMembers)
        .innerJoin(users, eq(users.id, cohortMembers.userId))
        .where(inArray(cohortMembers.id, mentorIds)),
      executor
        .select({
          mentorshipGroupId: mentorshipGroupStudents.mentorshipGroupId,
          cohortMemberId: mentorshipGroupStudents.cohortMemberId,
          joinedAt: mentorshipGroupStudents.joinedAt,
          user: userFields,
        })
        .from(mentorshipGroupStudents)
        .innerJoin(
          cohortMembers,
          eq(cohortMembers.id, mentorshipGroupStudents.cohortMemberId),
        )
        .innerJoin(users, eq(users.id, cohortMembers.userId))
        .where(
          and(
            inArray(mentorshipGroupStudents.mentorshipGroupId, groupIds),
            isLiveMembership(now),
          ),
        )
        .orderBy(
          asc(sql`lower(coalesce(${users.lastName}, ''))`),
          asc(sql`lower(coalesce(${users.firstName}, ''))`),
          asc(users.email),
          asc(mentorshipGroupStudents.id),
        ),
    ]);

    const mentorByMember = new Map(
      mentors.map((row) => [row.cohortMemberId, row]),
    );
    const studentsByGroup = new Map<string, MentorshipGroupStudentDto[]>();
    for (const row of students) {
      const list = studentsByGroup.get(row.mentorshipGroupId) ?? [];
      list.push({
        cohortMemberId: row.cohortMemberId,
        joinedAt: row.joinedAt,
        user: row.user,
      });
      studentsByGroup.set(row.mentorshipGroupId, list);
    }

    return rows.map((row) => {
      const mentor = mentorByMember.get(row.mentorMemberId);
      if (!mentor) {
        // The FK makes this unreachable; failing loudly beats returning a
        // group whose mentor silently vanished.
        throw new MentorshipGroupNotFoundException(
          `Mentor membership ${row.mentorMemberId} not found`,
          { cohortId: row.cohortId, groupId: row.id },
        );
      }
      return {
        id: row.id,
        cohortId: row.cohortId,
        name: row.name,
        description: row.description,
        mentor,
        students: studentsByGroup.get(row.id) ?? [],
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
  }

  private async findGroup(
    executor: DbExecutor,
    cohortId: string,
    groupId: string,
    lock = false,
  ): Promise<MentorshipGroup> {
    const where = and(
      eq(mentorshipGroups.id, groupId),
      eq(mentorshipGroups.cohortId, cohortId),
    );
    const rows = lock
      ? await (executor as Tx)
          .select()
          .from(mentorshipGroups)
          .where(where)
          .for('update')
      : await executor.select().from(mentorshipGroups).where(where).limit(1);

    const [row] = rows;
    if (!row) {
      throw new MentorshipGroupNotFoundException(
        `Mentorship group ${groupId} not found in cohort ${cohortId}`,
        { cohortId, groupId },
      );
    }
    return row;
  }

  private async assertMentor(
    executor: Tx,
    cohortId: string,
    mentorMemberId: string,
  ): Promise<void> {
    const [member] = await executor
      .select({
        id: cohortMembers.id,
        role: cohortMembers.role,
        leftAt: cohortMembers.leftAt,
        accessExpiresAt: cohortMembers.accessExpiresAt,
      })
      .from(cohortMembers)
      .where(
        and(
          eq(cohortMembers.id, mentorMemberId),
          eq(cohortMembers.cohortId, cohortId),
        ),
      )
      // Held for the rest of the transaction: ending this membership takes
      // the same row for update, so it cannot slip in between this check and
      // the group that points at it.
      .for('share');

    if (!member) {
      throw new CohortMemberNotFoundException(
        `No membership ${mentorMemberId} in cohort ${cohortId}`,
        { cohortId, mentorMemberId },
      );
    }
    if (member.role !== CohortRole.Mentor) {
      throw new MentorshipGroupInvalidArgumentException(
        'mentorMemberId must be a mentor in this cohort',
        { cohortId, mentorMemberId, role: member.role },
      );
    }
    const now = new Date();
    if (
      member.leftAt !== null ||
      (member.accessExpiresAt !== null && member.accessExpiresAt <= now)
    ) {
      throw new MentorshipGroupConflictException(
        'That mentor membership is no longer live',
        { cohortId, mentorMemberId },
      );
    }
  }

  private async assertStudent(
    executor: Tx,
    cohortId: string,
    cohortMemberId: string,
  ): Promise<void> {
    const [member] = await executor
      .select({
        id: cohortMembers.id,
        role: cohortMembers.role,
        status: cohortMembers.status,
        leftAt: cohortMembers.leftAt,
        accessExpiresAt: cohortMembers.accessExpiresAt,
      })
      .from(cohortMembers)
      .where(
        and(
          eq(cohortMembers.id, cohortMemberId),
          eq(cohortMembers.cohortId, cohortId),
        ),
      )
      // Held for the rest of the transaction, so a membership ending at the
      // same moment either finishes first (and this refuses) or waits and
      // then removes the link this transaction is about to add.
      .for('share');

    if (!member) {
      throw new CohortMemberNotFoundException(
        `No membership ${cohortMemberId} in cohort ${cohortId}`,
        { cohortId, cohortMemberId },
      );
    }
    if (member.role !== CohortRole.Student) {
      throw new MentorshipGroupInvalidArgumentException(
        'cohortMemberId must be a student in this cohort',
        { cohortId, cohortMemberId, role: member.role },
      );
    }

    const now = new Date();
    if (
      member.leftAt !== null ||
      member.status !== StudentStatus.Active ||
      (member.accessExpiresAt !== null && member.accessExpiresAt <= now)
    ) {
      throw new MentorshipGroupConflictException(
        'That student membership is no longer live',
        { cohortId, cohortMemberId },
      );
    }
  }

  /**
   * Turns the named constraints the routes can trip into the answers a client
   * can act on. Anything else is a genuine failure and is rethrown.
   */
  private translateWriteError(
    err: unknown,
    context: Record<string, unknown>,
  ): unknown {
    if (isUniqueViolation(err, 'mentorship_groups_cohort_name_unique')) {
      return new MentorshipGroupConflictException(
        'A mentorship group with that name already exists in this cohort',
        context,
      );
    }
    if (isUniqueViolation(err, 'mentorship_groups_one_per_mentor')) {
      return new MentorshipGroupConflictException(
        'That mentor already leads a mentorship group in this cohort',
        context,
      );
    }
    if (isUniqueViolation(err, 'mentorship_group_students_unique')) {
      return new MentorshipGroupConflictException(
        'That student is already in this mentorship group',
        context,
      );
    }
    if (isUniqueViolation(err, 'mentorship_group_students_one_per_cohort')) {
      return new MentorshipGroupConflictException(
        'That student is already in a mentorship group in this cohort',
        context,
      );
    }
    if (isCheckViolation(err, 'mentorship_groups_name_not_blank')) {
      return new MentorshipGroupInvalidArgumentException(
        'name must not be blank',
        context,
      );
    }
    if (isForeignKeyViolation(err, 'mentorship_groups_mentor_in_cohort')) {
      return new MentorshipGroupInvalidArgumentException(
        'mentorMemberId must be a mentor in this cohort',
        context,
      );
    }
    if (
      isForeignKeyViolation(err, 'mentorship_group_students_student_in_cohort')
    ) {
      return new MentorshipGroupInvalidArgumentException(
        'cohortMemberId must be a student in this cohort',
        context,
      );
    }
    if (isForeignKeyViolation(err)) {
      return new MentorshipGroupNotFoundException(
        'A referenced cohort, membership or group does not exist',
        context,
      );
    }
    return err;
  }
}
