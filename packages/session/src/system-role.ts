/**
 * USERS.system_role, as both services have to read it: campus-api decides
 * what a role may do on its routes, and world decides whether an account may
 * enter a cohort it is not a member of. Defined once, because two copies of
 * "who counts as an admin" drift the moment a role is added — and then one
 * service lets somebody through that the other turns away.
 */
export enum SystemRole {
  User = 'user',
  Admin = 'admin',
  /**
   * An admin nobody can demote. Set only by the seed, from
   * DEFAULT_ADMIN_EMAIL: no route grants it and no route takes it away, so
   * there is always somebody who can make and unmake the other admins.
   */
  SuperAdmin = 'super_admin',
}

/**
 * Whether a role may do what admins do. Both admin roles may; what sets a
 * super admin apart is only that the role cannot be changed through the API.
 *
 * Asked of the role rather than compared against `admin` at each call site,
 * so a check written before the second role existed cannot quietly lock the
 * super admins out. Takes the column's text as well as the enum: world reads
 * the role straight off the row, and a value this does not know is no admin.
 */
export function hasAdminPowers(role: string): boolean {
  return role === SystemRole.Admin || role === SystemRole.SuperAdmin;
}
