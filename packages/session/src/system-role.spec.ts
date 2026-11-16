import { describe, expect, it } from 'vitest';

import { SystemRole, hasAdminPowers } from './system-role.js';

describe('hasAdminPowers', () => {
  it.each([
    [SystemRole.Admin, true],
    [SystemRole.SuperAdmin, true],
    [SystemRole.User, false],
  ])('answers for the role %s', (role, expected) => {
    expect(hasAdminPowers(role)).toBe(expected);
  });

  // world hands over the column's text. Something this does not recognise —
  // a role added to the database before this package knew of it — is not an
  // admin: the safe way to be wrong.
  it.each(['', 'ADMIN', 'owner'])(
    'treats the unknown value %j as no admin',
    (value) => {
      expect(hasAdminPowers(value)).toBe(false);
    },
  );

  it('names exactly the roles the database has', () => {
    expect(Object.values(SystemRole)).toEqual(['user', 'admin', 'super_admin']);
  });
});
