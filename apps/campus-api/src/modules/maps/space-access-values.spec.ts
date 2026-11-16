import { describe, expect, it } from 'vitest';

import {
  ACTIVE_STUDENT_STATUS,
  COHORT_ROLES,
  SPACE_ACCESS,
} from '@campus/space-access';

import { CohortRole, StudentStatus } from '../cohorts/schema.js';
import { SpaceAccess, spaceAccessEnum } from './schema.js';

/*
 * @campus/space-access decides who may enter a space from plain facts, and it
 * names the values itself — it may not import this schema, or it would stop
 * being a package world can use without a database. So the strings it matches
 * are a second copy of what the enums hold, and a second copy drifts.
 *
 * Drift here would not fail a build: a new access setting or cohort role would
 * be written by this app and read as an unknown value by the shared rule,
 * which refuses where the database allows. These are the tripwire — the same
 * idea as system-role's "names exactly roles the database has", and, like it,
 * no database needed.
 */
describe('the shared space-access package names what the database has', () => {
  it('has every access setting, and no others', () => {
    expect(sorted(Object.values(SpaceAccess))).toEqual(
      sorted(Object.values(SPACE_ACCESS)),
    );
  });

  it('writes those settings into the space_access enum', () => {
    expect(sorted([...spaceAccessEnum.enumValues])).toEqual(
      sorted(Object.values(SPACE_ACCESS)),
    );
  });

  it('has the cohort roles the entry rules name', () => {
    expect(CohortRole.Student).toBe(COHORT_ROLES.Student);
    expect(CohortRole.Professor).toBe(COHORT_ROLES.Professor);
    expect(CohortRole.Mentor).toBe(COHORT_ROLES.Mentor);
    expect(CohortRole.Guest).toBe(COHORT_ROLES.Guest);
  });

  it('has the student status that counts as in good standing', () => {
    expect(StudentStatus.Active).toBe(ACTIVE_STUDENT_STATUS);
  });
});

/** Order says nothing: the two were written in different orders on purpose. */
function sorted(values: string[]): string[] {
  return [...values].sort();
}
