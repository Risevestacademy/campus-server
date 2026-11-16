import type { Request } from 'express';

import type { SystemRole } from '../../modules/users/schema.js';

/**
 * Neutral auth contract owned by the Google-auth side.
 *
 * Whatever performs authentication (Google session middleware/guard) must
 * attach this to the request before authorization guards run:
 *
 *   req.user = { id, email, systemRole };
 *
 * `systemRole` is USERS.system_role. Typed as the enum rather than a bare
 * string so a guard comparing against it cannot quietly go on matching a
 * value that no longer exists.
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  systemRole: SystemRole;
}

export type AuthenticatedRequest = Request & { user?: AuthenticatedUser };
