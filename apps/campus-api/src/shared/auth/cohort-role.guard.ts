import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';

import { CohortInvalidArgumentException } from '../../modules/cohorts/cohorts.exceptions.js';
import {
  AccessDeniedException,
  NotAuthenticatedException,
} from '../exceptions/index.js';
import { hasAdminPowers } from '../../modules/users/schema.js';
import type { AuthenticatedRequest } from './authenticated-user.js';
import {
  CohortRoleService,
  type CohortMembership,
} from './cohort-role.service.js';

type CohortRoleRequest = AuthenticatedRequest & {
  cohortMembership?: CohortMembership;
};

interface RouteIds {
  cohortId: string;
  trackId?: string;
  groupId?: string;
}

/**
 * Authorization for the cohort roles, after SessionGuard has identified the
 * caller. Admins pass, as they do every authorization check in the API; the
 * role itself is always read from the database.
 *
 * The ids come only from the route. A missing or malformed id is a bad
 * request, not a reason to let the caller through.
 */
@Injectable()
abstract class CohortRoleGuardBase implements CanActivate {
  constructor(protected readonly roles: CohortRoleService) {}

  protected abstract readonly requiredParams: readonly (keyof RouteIds)[];
  protected abstract readonly deniedMessage: string;

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<CohortRoleRequest>();

    if (!req.user) {
      throw new NotAuthenticatedException('Authentication required');
    }

    const ids = this.readIds(req);
    if (hasAdminPowers(req.user.systemRole)) {
      return true;
    }

    const membership = await this.resolve(req.user.id, ids);
    if (!membership) {
      throw new AccessDeniedException(this.deniedMessage);
    }

    req.cohortMembership = membership;
    return true;
  }

  protected abstract resolve(
    userId: string,
    ids: RouteIds,
  ): Promise<CohortMembership | null>;

  private readIds(req: CohortRoleRequest): RouteIds {
    const ids: RouteIds = { cohortId: '' };
    for (const name of this.requiredParams) {
      const value = req.params[name];
      if (typeof value !== 'string' || !isUUID(value)) {
        throw new CohortInvalidArgumentException(`${name} must be a UUID`, {
          [name]: value ?? null,
        });
      }
      ids[name] = value;
    }
    return ids;
  }
}

/** The caller is a live professor of this cohort's track. */
@Injectable()
export class ProfessorOfTrackGuard extends CohortRoleGuardBase {
  protected readonly requiredParams = ['cohortId', 'trackId'] as const;
  protected readonly deniedMessage = 'Professor of this cohort track required';

  protected resolve(
    userId: string,
    ids: RouteIds,
  ): Promise<CohortMembership | null> {
    return this.roles.findProfessorOfTrack(
      userId,
      ids.cohortId,
      ids.trackId as string,
    );
  }
}

/** The caller is the live mentor of this cohort's group. */
@Injectable()
export class MentorOfGroupGuard extends CohortRoleGuardBase {
  protected readonly requiredParams = ['cohortId', 'groupId'] as const;
  protected readonly deniedMessage = 'Mentor of this mentorship group required';

  protected resolve(
    userId: string,
    ids: RouteIds,
  ): Promise<CohortMembership | null> {
    return this.roles.findMentorOfGroup(
      userId,
      ids.cohortId,
      ids.groupId as string,
    );
  }
}

/** Either role passes; a caller holding neither is refused. */
@Injectable()
export class ProfessorOfTrackOrMentorOfGroupGuard extends CohortRoleGuardBase {
  protected readonly requiredParams = [
    'cohortId',
    'trackId',
    'groupId',
  ] as const;
  protected readonly deniedMessage =
    'Professor of this cohort track or mentor of this mentorship group required';

  protected resolve(
    userId: string,
    ids: RouteIds,
  ): Promise<CohortMembership | null> {
    return this.roles.findProfessorOfTrackOrMentorOfGroup(
      userId,
      ids.cohortId,
      ids.trackId as string,
      ids.groupId as string,
    );
  }
}
