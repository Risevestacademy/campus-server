import { describe, expect, it } from 'vitest';

import {
  ACTIVE_STUDENT_STATUS,
  COHORT_ROLES,
  SPACE_ACCESS,
  isLiveGrant,
  isLiveMembership,
  mayEnter,
  type CohortMembershipFacts,
  type PersonFacts,
  type SpaceAccess,
  type SpaceFacts,
  type SpaceGrantFacts,
} from './space-access.js';

/** The moment every table below stands at. */
const AT = new Date('2026-10-19T12:00:00.000Z');
const DAY = 86_400_000;

/** The cohort the check is made for, and the one next to it. */
const COHORT = 'cohort-1';
const ELSEWHERE = 'cohort-2';
const TRACK = 'track-1';

function membership(
  overrides: Partial<CohortMembershipFacts> = {},
): CohortMembershipFacts {
  return {
    cohortId: COHORT,
    role: COHORT_ROLES.Student,
    leftAt: null,
    status: ACTIVE_STUDENT_STATUS,
    accessExpiresAt: null,
    trackId: TRACK,
    ...overrides,
  };
}

function person(overrides: Partial<PersonFacts> = {}): PersonFacts {
  return {
    userId: 'person-1',
    systemRole: 'user',
    cohortId: COHORT,
    membership: membership(),
    ...overrides,
  };
}

function space(overrides: Partial<SpaceFacts> = {}): SpaceFacts {
  return {
    kind: 'classroom',
    access: SPACE_ACCESS.Cohort,
    retiredAt: null,
    grants: [],
    ...overrides,
  };
}

/** A grant to the person, already running since the day before `AT`. */
function grant(overrides: Partial<SpaceGrantFacts> = {}): SpaceGrantFacts {
  return {
    toUserId: 'person-1',
    toTrackId: null,
    validFrom: new Date(AT.getTime() - DAY),
    validTo: null,
    ...overrides,
  };
}

/**
 * Every standing a caller can present, on a space with no grant on it. The
 * table's rows; the four access settings are its columns.
 */
const STANDINGS: ReadonlyArray<{ name: string; who: PersonFacts }> = [
  { name: 'an admin', who: person({ systemRole: 'admin' }) },
  { name: 'a super admin', who: person({ systemRole: 'super_admin' }) },
  { name: 'a member', who: person() },
  {
    name: 'a professor',
    who: person({
      membership: membership({ role: 'professor', status: null }),
    }),
  },
  {
    name: 'a mentor',
    who: person({ membership: membership({ role: 'mentor', status: null }) }),
  },
  {
    name: 'a guest',
    who: person({
      membership: membership({
        role: COHORT_ROLES.Guest,
        accessExpiresAt: new Date(AT.getTime() + DAY),
      }),
    }),
  },
  {
    name: 'a member whose membership has ended',
    who: person({
      membership: membership({ leftAt: new Date(AT.getTime() - DAY) }),
    }),
  },
  {
    name: 'a guest whose visit has run out',
    who: person({
      membership: membership({
        role: COHORT_ROLES.Guest,
        accessExpiresAt: new Date(AT.getTime() - DAY),
      }),
    }),
  },
  {
    name: 'a member walking a cohort they are not in',
    who: person({ membership: membership({ cohortId: ELSEWHERE }) }),
  },
  { name: 'somebody in no cohort', who: person({ membership: null }) },
];

/**
 * What each standing gets on each access setting, with no grant on the space.
 * Read as rows by name and columns by setting; the admin's row is the same
 * across every column because admins are decided before any of it, and the
 * guest's row is where `open` and `cohort` come apart.
 */
const NO_GRANT: Record<string, Record<SpaceAccess, boolean>> = {
  'an admin': { open: true, cohort: true, invite: true, request: true },
  'a super admin': { open: true, cohort: true, invite: true, request: true },
  'a member': { open: true, cohort: true, invite: false, request: false },
  'a professor': { open: true, cohort: true, invite: false, request: false },
  'a mentor': { open: true, cohort: true, invite: false, request: false },
  'a guest': { open: true, cohort: false, invite: false, request: false },
  'a member whose membership has ended': {
    open: false,
    cohort: false,
    invite: false,
    request: false,
  },
  'a guest whose visit has run out': {
    open: false,
    cohort: false,
    invite: false,
    request: false,
  },
  'a member walking a cohort they are not in': {
    open: false,
    cohort: false,
    invite: false,
    request: false,
  },
  'somebody in no cohort': {
    open: false,
    cohort: false,
    invite: false,
    request: false,
  },
};

const ACCESS = Object.values(SPACE_ACCESS) as SpaceAccess[];

describe('every access setting against every standing', () => {
  const rows = STANDINGS.flatMap(({ name, who }) =>
    ACCESS.map(
      (access) => [name, access, NO_GRANT[name][access], who] as const,
    ),
  );

  it.each(rows)(
    '%s on a %s space is admitted: %s',
    (_name, access, expected, who) => {
      expect(mayEnter(who, space({ access }), AT)).toBe(expected);
    },
  );

  it('covers every setting against every standing', () => {
    expect(STANDINGS.map(({ name }) => name)).toEqual([
      'an admin',
      'a super admin',
      'a member',
      'a professor',
      'a mentor',
      'a guest',
      'a member whose membership has ended',
      'a guest whose visit has run out',
      'a member walking a cohort they are not in',
      'somebody in no cohort',
    ]);
    expect(ACCESS).toEqual(['open', 'cohort', 'invite', 'request']);
    expect(Object.keys(NO_GRANT)).toHaveLength(STANDINGS.length);
    for (const name of Object.keys(NO_GRANT)) {
      expect(Object.keys(NO_GRANT[name])).toHaveLength(ACCESS.length);
    }
  });
});

/*
 * A space with no kind is not set up yet: admins only, and the access setting
 * on the row says nothing either way — an unset space can still carry the
 * closed settings the sync gives it.
 */
describe('a space with no kind', () => {
  const unset = () => space({ kind: null, access: SPACE_ACCESS.Open });

  it('admits an admin', () => {
    expect(mayEnter(person({ systemRole: 'admin' }), unset(), AT)).toBe(true);
  });

  it('refuses a member, whatever the access setting says', () => {
    expect(mayEnter(person(), unset(), AT)).toBe(false);
    expect(
      mayEnter(
        person(),
        space({ kind: null, access: SPACE_ACCESS.Invite }),
        AT,
      ),
    ).toBe(false);
  });

  it('refuses a guest', () => {
    const guest = person({
      membership: membership({
        role: COHORT_ROLES.Guest,
        accessExpiresAt: new Date(AT.getTime() + DAY),
      }),
    });
    expect(mayEnter(guest, unset(), AT)).toBe(false);
  });
});

/*
 * Retired answers before everything else, so this is where "admins enter
 * anything" meets "a retired space admits nobody": the space wins.
 */
describe('a retired space', () => {
  const retired = () =>
    space({
      access: SPACE_ACCESS.Open,
      retiredAt: new Date(AT.getTime() - DAY),
    });

  it('admits nobody, not even an admin', () => {
    expect(mayEnter(person({ systemRole: 'admin' }), retired(), AT)).toBe(
      false,
    );
  });

  it('admits no member and no guest', () => {
    expect(mayEnter(person(), retired(), AT)).toBe(false);
    const guest = person({
      membership: membership({
        role: COHORT_ROLES.Guest,
        accessExpiresAt: new Date(AT.getTime() + DAY),
      }),
    });
    expect(mayEnter(guest, retired(), AT)).toBe(false);
  });

  it('stays shut even with no kind, where an unretired space admits admins', () => {
    expect(
      mayEnter(
        person({ systemRole: 'admin' }),
        space({ kind: null, retiredAt: new Date(AT.getTime() - DAY) }),
        AT,
      ),
    ).toBe(false);
  });
});

/*
 * invite and request are the same door. The grant decides: it has to name
 * this person or their track in this cohort, and it has to be inside its
 * window right now.
 */
describe.each([SPACE_ACCESS.Invite, SPACE_ACCESS.Request])(
  'a %s space, where the grant decides',
  (access) => {
    it('admits the person while a grant to them is live', () => {
      expect(mayEnter(person(), space({ access, grants: [grant()] }), AT)).toBe(
        true,
      );
    });

    it('admits everybody on a track the grant names', () => {
      const toTrack = grant({ toUserId: null, toTrackId: TRACK });
      expect(mayEnter(person(), space({ access, grants: [toTrack] }), AT)).toBe(
        true,
      );
    });

    it('refuses a grant that has run out', () => {
      const expired = grant({ validTo: new Date(AT.getTime() - 1) });
      expect(mayEnter(person(), space({ access, grants: [expired] }), AT)).toBe(
        false,
      );
    });

    it('refuses a grant that ends at this very moment', () => {
      const ending = grant({ validTo: AT });
      expect(mayEnter(person(), space({ access, grants: [ending] }), AT)).toBe(
        false,
      );
    });

    it('refuses a grant that has not started', () => {
      const future = grant({ validFrom: new Date(AT.getTime() + 1) });
      expect(mayEnter(person(), space({ access, grants: [future] }), AT)).toBe(
        false,
      );
    });

    it('admits from the moment a grant starts', () => {
      const starting = grant({ validFrom: AT });
      expect(
        mayEnter(person(), space({ access, grants: [starting] }), AT),
      ).toBe(true);
    });

    it('refuses a grant that has run out on their track', () => {
      const expired = grant({
        toUserId: null,
        toTrackId: TRACK,
        validTo: new Date(AT.getTime() - 1),
      });
      expect(mayEnter(person(), space({ access, grants: [expired] }), AT)).toBe(
        false,
      );
    });

    it('refuses a grant to another track, however live', () => {
      const otherTrack = grant({ toUserId: null, toTrackId: 'track-2' });
      expect(
        mayEnter(person(), space({ access, grants: [otherTrack] }), AT),
      ).toBe(false);
    });

    it('refuses a grant to somebody else entirely', () => {
      const theirs = grant({ toUserId: 'person-2' });
      expect(mayEnter(person(), space({ access, grants: [theirs] }), AT)).toBe(
        false,
      );
    });

    it('refuses when there are no grants at all', () => {
      expect(mayEnter(person(), space({ access, grants: [] }), AT)).toBe(false);
    });

    it('still admits an admin, grant or no grant', () => {
      const admin = person({ systemRole: 'admin' });
      expect(mayEnter(admin, space({ access, grants: [grant()] }), AT)).toBe(
        true,
      );
      expect(mayEnter(admin, space({ access, grants: [] }), AT)).toBe(true);
    });
  },
);

describe('a grant against the setting around it', () => {
  it('opens nothing on a cohort space, where a guest is concerned', () => {
    const guest = person({
      membership: membership({
        role: COHORT_ROLES.Guest,
        accessExpiresAt: new Date(AT.getTime() + DAY),
      }),
    });
    expect(
      mayEnter(
        guest,
        space({ access: SPACE_ACCESS.Cohort, grants: [grant()] }),
        AT,
      ),
    ).toBe(false);
  });

  it('changes nothing on an open space, grant expired or not', () => {
    const expired = grant({ validTo: new Date(AT.getTime() - DAY) });
    expect(
      mayEnter(
        person(),
        space({ access: SPACE_ACCESS.Open, grants: [expired] }),
        AT,
      ),
    ).toBe(true);
  });

  it('cannot resurrect a membership that has ended', () => {
    const ended = person({
      membership: membership({ leftAt: new Date(AT.getTime() - DAY) }),
    });
    expect(
      mayEnter(
        ended,
        space({ access: SPACE_ACCESS.Invite, grants: [grant()] }),
        AT,
      ),
    ).toBe(false);
  });
});

describe('a space whose access setting is not one this package knows', () => {
  it('refuses a member', () => {
    expect(mayEnter(person(), space({ access: 'backstage' }), AT)).toBe(false);
  });

  it('admits an admin all the same', () => {
    expect(
      mayEnter(
        person({ systemRole: 'admin' }),
        space({ access: 'backstage' }),
        AT,
      ),
    ).toBe(true);
  });
});

describe('isLiveMembership', () => {
  it('takes an ordinary standing membership as live', () => {
    expect(isLiveMembership(membership(), AT)).toBe(true);
  });

  it('takes staff as live without a student status to their name', () => {
    expect(
      isLiveMembership(membership({ role: 'professor', status: null }), AT),
    ).toBe(true);
  });

  it('takes a student with no status as not live: half an enrolment', () => {
    expect(isLiveMembership(membership({ status: null }), AT)).toBe(false);
  });

  it('takes a dismissed, withdrawn or deferred student as not live', () => {
    for (const status of ['dismissed', 'withdrawn', 'deferred', 'graduated']) {
      expect(isLiveMembership(membership({ status }), AT)).toBe(false);
    }
  });

  it('takes a membership that has ended as not live', () => {
    expect(isLiveMembership(membership({ leftAt: AT }), AT)).toBe(false);
  });

  it('takes a visit that ends exactly now as run out', () => {
    expect(isLiveMembership(membership({ accessExpiresAt: AT }), AT)).toBe(
      false,
    );
  });
});

describe('isLiveGrant', () => {
  it('takes a grant with no end as live', () => {
    expect(isLiveGrant(grant(), AT)).toBe(true);
  });

  it('takes a grant still inside its window as live', () => {
    const inside = grant({
      validFrom: new Date(AT.getTime() - DAY),
      validTo: new Date(AT.getTime() + DAY),
    });
    expect(isLiveGrant(inside, AT)).toBe(true);
  });

  it('takes a grant that has ended, or has not begun, as not live', () => {
    expect(isLiveGrant(grant({ validTo: AT }), AT)).toBe(false);
    expect(isLiveGrant(grant({ validFrom: AT }), AT)).toBe(true);
    expect(
      isLiveGrant(grant({ validFrom: new Date(AT.getTime() + 1) }), AT),
    ).toBe(false);
  });
});

describe('the clock', () => {
  it('reads the current moment when the caller names none', () => {
    const live: SpaceGrantFacts = {
      toUserId: 'person-1',
      toTrackId: null,
      validFrom: new Date(Date.now() - DAY),
      validTo: null,
    };
    expect(
      mayEnter(
        person(),
        space({ access: SPACE_ACCESS.Invite, grants: [live] }),
      ),
    ).toBe(true);
  });

  it('answers the same for a standing space whichever side of now it is asked', () => {
    const past = new Date(AT.getTime() - DAY);
    expect(
      mayEnter(person(), space({ access: SPACE_ACCESS.Cohort }), past),
    ).toBe(true);
  });
});
