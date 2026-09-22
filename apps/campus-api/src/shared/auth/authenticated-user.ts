import type { Request } from 'express';

/**
 * Neutral auth contract owned by the Google-auth side.
 *
 * Whatever performs authentication (Google session middleware/guard) must
 * attach this to the request before authorization guards run:
 *
 *   req.user = { id, email, systemRole };
 *
 * `systemRole` mirrors USERS.system_role ('user' | 'admin').
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  systemRole: string;
}

export type AuthenticatedRequest = Request & { user?: AuthenticatedUser };
