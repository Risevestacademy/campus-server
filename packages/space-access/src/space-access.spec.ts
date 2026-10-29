import { describe, expect, it } from 'vitest';

import {
  ACTIVE_STUDENT_STATUS,
  COHORT_ROLES,
  SPACE_ACCESS,
  mayEnter,
  type CohortMembershipFacts,
  type PersonFacts,
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
const GROUP = 'group-1';

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
    mentorshipGroupId: null,
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
    kind: 'meeting_room',
    access: SPACE_ACCESS.Normal,
    retiredAt: null,
    locked: false,
    grants: [],
    ...overrides,
  };
}

/** A designated space with these entries on its list. */
function designated(...grants: SpaceGrantFacts[]): SpaceFacts {
  return space({ kind: 'classroom', access: SPACE_ACCESS.Designated, grants });
}

/**
 * An entry naming the person, already counting since the day before `AT`.
 * Pass another subject to name somebody else instead: the others are cleared.
 */
function entry(overrides: Partial<SpaceGrantFacts> = {}): SpaceGrantFacts {
  const names =
    'toTrackId' in overrides ||
    'toCohortRole' in overrides ||
    'toSystemRole' in overrides ||
    'toGroupId' in overrides;
  return {
    toUserId: names ? null : 'person-1',
    toTrackId: null,
    toCohortRole: null,
    toSystemRole: null,
    toGroupId: null,
    validFrom: new Date(AT.getTime() - DAY),
    validTo: null,
    ...overrides,
  };
}

const professor = membership({ role: 'professor', status: null });
const guest = membership({
  role: COHORT_ROLES.Guest,
  status: null,
  accessExpiresAt: new Date(AT.getTime() + DAY),
});

/**
 * Every standing a caller can present. The table's rows; the three ways a
 * space can stand to them are its columns.
 */
const STANDINGS: ReadonlyArray<{ name: string; who: PersonFacts }> = [
  { name: 'an admin', who: person({ systemRole: 'admin' }) },
  { name: 'a super admin', who: person({ systemRole: 'super_admin' }) },
  { name: 'a member', who: person() },
  { name: 'a professor', who: person({ membership: professor }) },
  {
    name: 'a mentor',
    who: person({ membership: membership({ role: 'mentor', status: null }) }),
  },
  {
    name: 'a member on no track',
    who: person({ membership: membership({ trackId: null }) }),
  },
  {
    name: 'a member with a role this package does not know',
    who: person({ membership: membership({ role: 'alumnus', status: null }) }),
  },
  { name: 'a guest', who: person({ membership: guest }) },
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
        status: null,
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

type Column = 'normal' | 'locked' | 'designated';

const COLUMNS: Record<Column, SpaceFacts> = {
  normal: space(),
  locked: space({ locked: true }),
  designated: designated(),
};

/**
 * What each standing gets: at a normal space, at a locked one, and at a
 * designated one with nobody on its list. The admin's row is the same across
 * because admins are decided before any of it; everybody in the campus,
 * guests included, walks into a normal space and no further.
 */
const TABLE: Record<string, Record<Column, boolean>> = {
  'an admin': { normal: true, locked: true, designated: true },
  'a super admin': { normal: true, locked: true, designated: true },
  'a member': { normal: true, locked: false, designated: false },
  'a professor': { normal: true, locked: false, designated: false },
  'a mentor': { normal: true, locked: false, designated: false },
  'a member on no track': { normal: true, locked: false, designated: false },
  'a member with a role this package does not know': {
    normal: true,
    locked: false,
    designated: false,
  },
  'a guest': { normal: true, locked: false, designated: false },
  'a member whose membership has ended': {
    normal: false,
    locked: false,
    designated: false,
  },
  'a guest whose visit has run out': {
    normal: false,
    locked: false,
    designated: false,
  },
  'a member walking a cohort they are not in': {
    normal: false,
    locked: false,
    designated: false,
  },
  'somebody in no cohort': { normal: false, locked: false, designated: false },
};

describe('every standing against every way a space can stand', () => {
  const rows = STANDINGS.flatMap(({ name, who }) =>
    (Object.keys(COLUMNS) as Column[]).map(
      (column) => [name, column, who, TABLE[name][column]] as const,
    ),
  );

  it.each(rows)('%s, at a %s space', (_, column, who, expected) => {
    expect(mayEnter(who, COLUMNS[column], AT)).toBe(expected);
  });

  it('covers every standing', () => {
    expect(Object.keys(TABLE).sort()).toEqual(
      STANDINGS.map(({ name }) => name).sort(),
    );
  });
});

describe('a space with no kind', () => {
  it('admits an admin', () => {
    expect(
      mayEnter(person({ systemRole: 'admin' }), space({ kind: null }), AT),
    ).toBe(true);
  });

  it('refuses a member, whatever the access setting says', () => {
    for (const access of Object.values(SPACE_ACCESS)) {
      expect(mayEnter(person(), space({ kind: null, access }), AT)).toBe(false);
    }
  });

  it('refuses somebody on its list', () => {
    expect(
      mayEnter(
        person(),
        space({
          kind: null,
          access: SPACE_ACCESS.Designated,
          grants: [entry()],
        }),
        AT,
      ),
    ).toBe(false);
  });
});

describe('a retired space', () => {
  const retired = { retiredAt: new Date(AT.getTime() - DAY) };

  it('admits nobody, not even an admin', () => {
    expect(mayEnter(person({ systemRole: 'admin' }), space(retired), AT)).toBe(
      false,
    );
    expect(
      mayEnter(person({ systemRole: 'super_admin' }), space(retired), AT),
    ).toBe(false);
  });

  it('admits nobody on its list', () => {
    expect(mayEnter(person(), { ...designated(entry()), ...retired }, AT)).toBe(
      false,
    );
  });

  it('stays shut even with no kind, where an unretired space admits admins', () => {
    expect(
      mayEnter(
        person({ systemRole: 'admin' }),
        space({ ...retired, kind: null }),
        AT,
      ),
    ).toBe(false);
  });
});

describe('a designated space’s list', () => {
  it('admits the person an entry names', () => {
    expect(mayEnter(person(), designated(entry()), AT)).toBe(true);
  });

  it('refuses an entry naming somebody else', () => {
    expect(
      mayEnter(person(), designated(entry({ toUserId: 'person-2' })), AT),
    ).toBe(false);
  });

  it('admits everybody on a track an entry names', () => {
    expect(
      mayEnter(person(), designated(entry({ toTrackId: TRACK })), AT),
    ).toBe(true);
  });

  it('refuses an entry for another track', () => {
    expect(
      mayEnter(person(), designated(entry({ toTrackId: 'track-2' })), AT),
    ).toBe(false);
  });

  it('refuses a track entry to a member on no track', () => {
    expect(
      mayEnter(
        person({ membership: membership({ trackId: null }) }),
        designated(entry({ toTrackId: TRACK })),
        AT,
      ),
    ).toBe(false);
  });

  it('admits a student in the mentorship group an entry names', () => {
    expect(
      mayEnter(
        person({ membership: membership({ mentorshipGroupId: GROUP }) }),
        designated(entry({ toGroupId: GROUP })),
        AT,
      ),
    ).toBe(true);
  });

  it('admits the mentor of the mentorship group an entry names', () => {
    expect(
      mayEnter(
        person({
          membership: membership({
            role: 'mentor',
            status: null,
            mentorshipGroupId: GROUP,
          }),
        }),
        designated(entry({ toGroupId: GROUP })),
        AT,
      ),
    ).toBe(true);
  });

  it('refuses a member in another mentorship group', () => {
    expect(
      mayEnter(
        person({ membership: membership({ mentorshipGroupId: 'group-2' }) }),
        designated(entry({ toGroupId: GROUP })),
        AT,
      ),
    ).toBe(false);
  });

  it('refuses a group entry to a member in no group', () => {
    expect(
      mayEnter(person(), designated(entry({ toGroupId: GROUP })), AT),
    ).toBe(false);
  });

  it('reads a group from the membership in the cohort being walked', () => {
    expect(
      mayEnter(
        person({
          membership: membership({
            cohortId: ELSEWHERE,
            mentorshipGroupId: GROUP,
          }),
        }),
        designated(entry({ toGroupId: GROUP })),
        AT,
      ),
    ).toBe(false);
  });

  it('admits everybody holding a cohort role an entry names, and nobody else', () => {
    const professors = designated(entry({ toCohortRole: 'professor' }));

    expect(mayEnter(person({ membership: professor }), professors, AT)).toBe(
      true,
    );
    expect(mayEnter(person(), professors, AT)).toBe(false);
  });

  /** A classroom's starting list: the cohort, its guests left out. */
  it('admits students, professors and mentors on a classroom list, and not a guest', () => {
    const classroom = designated(
      entry({ toCohortRole: 'student' }),
      entry({ toCohortRole: 'professor' }),
      entry({ toCohortRole: 'mentor' }),
    );

    expect(mayEnter(person(), classroom, AT)).toBe(true);
    expect(mayEnter(person({ membership: professor }), classroom, AT)).toBe(
      true,
    );
    expect(mayEnter(person({ membership: guest }), classroom, AT)).toBe(false);
  });

  it('admits a guest an entry names, by person or by role', () => {
    const guestPerson = person({ membership: guest });

    expect(mayEnter(guestPerson, designated(entry()), AT)).toBe(true);
    expect(
      mayEnter(guestPerson, designated(entry({ toCohortRole: 'guest' })), AT),
    ).toBe(true);
  });

  it('admits everybody holding a system role an entry names', () => {
    expect(
      mayEnter(person(), designated(entry({ toSystemRole: 'user' })), AT),
    ).toBe(true);
    expect(
      mayEnter(person(), designated(entry({ toSystemRole: 'admin' })), AT),
    ).toBe(false);
  });

  it('refuses an entry that has run out', () => {
    expect(
      mayEnter(
        person(),
        designated(entry({ validTo: new Date(AT.getTime() - 1) })),
        AT,
      ),
    ).toBe(false);
  });

  it('refuses an entry that ends at this very moment', () => {
    expect(mayEnter(person(), designated(entry({ validTo: AT })), AT)).toBe(
      false,
    );
  });

  it('refuses an entry that has not started', () => {
    expect(
      mayEnter(
        person(),
        designated(entry({ validFrom: new Date(AT.getTime() + 1) })),
        AT,
      ),
    ).toBe(false);
  });

  it('admits from the moment an entry starts', () => {
    expect(mayEnter(person(), designated(entry({ validFrom: AT })), AT)).toBe(
      true,
    );
  });

  it('refuses an entry naming nobody', () => {
    expect(mayEnter(person(), designated(entry({ toUserId: null })), AT)).toBe(
      false,
    );
  });

  it('cannot bring back a membership that has ended', () => {
    expect(
      mayEnter(
        person({
          membership: membership({ leftAt: new Date(AT.getTime() - DAY) }),
        }),
        designated(entry(), entry({ toCohortRole: 'student' })),
        AT,
      ),
    ).toBe(false);
  });

  it('reads a role from the membership in the cohort being walked', () => {
    expect(
      mayEnter(
        person({ membership: membership({ cohortId: ELSEWHERE }) }),
        designated(entry({ toCohortRole: 'student' })),
        AT,
      ),
    ).toBe(false);
  });
});

describe('a normal space', () => {
  it('ignores its list: nobody is kept out of it to be let in', () => {
    expect(
      mayEnter(
        person(),
        space({ grants: [entry({ toUserId: 'person-2' })] }),
        AT,
      ),
    ).toBe(true);
  });

  it('keeps out somebody on its list once it is locked', () => {
    expect(
      mayEnter(person(), space({ locked: true, grants: [entry()] }), AT),
    ).toBe(false);
  });

  it('lets an admin past the lock', () => {
    expect(
      mayEnter(person({ systemRole: 'admin' }), space({ locked: true }), AT),
    ).toBe(true);
  });

  it('cannot be locked against anybody on a designated space’s list', () => {
    expect(
      mayEnter(person(), { ...designated(entry()), locked: true }, AT),
    ).toBe(true);
  });
});

describe('an access setting this package does not know', () => {
  it('admits admins only', () => {
    const unknown = space({ access: 'cohort', grants: [entry()] });

    expect(mayEnter(person(), unknown, AT)).toBe(false);
    expect(mayEnter(person({ systemRole: 'admin' }), unknown, AT)).toBe(true);
  });
});
