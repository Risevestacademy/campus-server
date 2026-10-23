import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';

import { hasAdminPowers } from '../../modules/users/schema.js';
import {
  AccessDeniedException,
  InvalidArgumentException,
  NotAuthenticatedException,
} from '../exceptions/index.js';
import type { AuthenticatedRequest } from './authenticated-user.js';
import {
  CohortRoleService,
  type CohortMembership,
} from './cohort-role.service.js';

type AllRouteIds = {
  cohortId: string;
  trackId: string;
  groupId: string;
};
type RouteId = keyof AllRouteIds;
type ProfessorOfTrackIds = readonly ['cohortId', 'trackId'];
type MentorOfGroupIds = readonly ['cohortId', 'groupId'];

type CohortRoleRequest = AuthenticatedRequest & {
  cohortMembership?: CohortMembership;
};

/**
 * Authorization for the cohort roles, after SessionGuard has identified the
 * caller. Admins pass, as they do every authorization check in the API; the
 * role itself is always read from the database.
 *
 * The ids come only from the route. A missing or malformed id is a bad
 * request, not a reason to let the caller through.
 */
@Injectable()
abstract class CohortRoleGuardBase<
  TRequired extends readonly RouteId[],
> implements CanActivate {
  constructor(protected readonly roles: CohortRoleService) {}

  protected abstract readonly requiredParams: TRequired;
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
    ids: Pick<AllRouteIds, TRequired[number]>,
  ): Promise<CohortMembership | null>;

  private readIds(
    req: CohortRoleRequest,
  ): Pick<AllRouteIds, TRequired[number]> {
    const ids: Partial<AllRouteIds> = {};
    for (const name of this.requiredParams) {
      const value = req.params[name];
      if (typeof value !== 'string' || !isUUID(value)) {
        throw new InvalidArgumentException(`${name} must be a UUID`, {
          [name]: value ?? null,
        });
      }
      ids[name] = value;
    }
    return ids as Pick<AllRouteIds, TRequired[number]>;
  }
}

/** The caller is a live professor of this cohort's track. */
@Injectable()
export class ProfessorOfTrackGuard extends CohortRoleGuardBase<ProfessorOfTrackIds> {
  protected readonly requiredParams = ['cohortId', 'trackId'] as const;
  protected readonly deniedMessage = 'Professor of this cohort track required';

  protected resolve(
    userId: string,
    ids: Pick<AllRouteIds, ProfessorOfTrackIds[number]>,
  ): Promise<CohortMembership | null> {
    return this.roles.findProfessorOfTrack(userId, ids.cohortId, ids.trackId);
  }
}

/** The caller is the live mentor of this cohort's group. */
@Injectable()
export class MentorOfGroupGuard extends CohortRoleGuardBase<MentorOfGroupIds> {
  protected readonly requiredParams = ['cohortId', 'groupId'] as const;
  protected readonly deniedMessage = 'Mentor of this mentorship group required';

  protected resolve(
    userId: string,
    ids: Pick<AllRouteIds, MentorOfGroupIds[number]>,
  ): Promise<CohortMembership | null> {
    return this.roles.findMentorOfGroup(userId, ids.cohortId, ids.groupId);
  }
}
