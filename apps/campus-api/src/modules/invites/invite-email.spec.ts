import { CohortRole } from '../cohorts/schema.js';
import { SystemRole } from '../users/schema.js';
import type { InvitePreviewResponseDto } from './dto/invite-preview.dto.js';
import {
  renderInviteEmail,
  renderInviteTemplateEmail,
} from './invite-email.js';

const LINK = 'https://dev.campusbyrise.com/invitation?token=abc';

const STUDENT: InvitePreviewResponseDto = {
  email: 'ada@campus.local',
  cohort: {
    name: 'Product Design 2026',
    code: 'PD26',
    startDate: null,
    endDate: null,
  },
  track: { name: 'Product Design', code: 'PD' },
  cohortRole: CohortRole.Student,
  systemRole: SystemRole.User,
  invitedBy: { firstName: 'Jerry', lastName: 'Smith' },
  expiresAt: new Date('2026-10-07T12:00:00.000Z'),
  guestAccessExpiresAt: null,
};

describe('renderInviteEmail', () => {
  it('names who invited them, to what, and as what', () => {
    const email = renderInviteEmail(STUDENT, LINK);

    expect(email.subject).toBe(
      'Jerry Smith invited you to Product Design 2026 on Campus by Rise',
    );
    expect(email.text).toContain(
      'Jerry Smith has invited you to join Product Design 2026 as a student on the Product Design track.',
    );
  });

  it('carries the link, the address to sign in with, and the expiry, in both parts', () => {
    const email = renderInviteEmail(STUDENT, LINK);

    for (const part of [email.text, email.html]) {
      expect(part).toContain(LINK);
      expect(part).toContain('ada@campus.local');
      expect(part).toContain('7 October 2026, 12:00 UTC');
    }
  });

  it('tells a guest when their visit ends', () => {
    const email = renderInviteEmail(
      {
        ...STUDENT,
        cohortRole: CohortRole.Guest,
        track: null,
        guestAccessExpiresAt: new Date('2026-10-05T17:00:00.000Z'),
      },
      LINK,
    );

    expect(email.text).toContain('as a guest.');
    expect(email.text).toContain(
      'your access ends on 5 October 2026, 17:00 UTC',
    );
  });

  it('describes an admin invite, which has no cohort', () => {
    const email = renderInviteEmail(
      {
        ...STUDENT,
        cohort: null,
        track: null,
        cohortRole: null,
        systemRole: SystemRole.Admin,
      },
      LINK,
    );

    expect(email.subject).toBe('Jerry Smith invited you to Campus by Rise');
    expect(email.text).toContain('to join Campus by Rise as an admin.');
  });

  it('still reads when the inviter has no name on record', () => {
    const email = renderInviteEmail(
      { ...STUDENT, invitedBy: { firstName: null, lastName: null } },
      LINK,
    );

    expect(email.subject).toBe(
      "You're invited to Product Design 2026 on Campus by Rise",
    );
    expect(email.text).toContain('Someone at Rise Academy has invited you');
  });

  // Names come from Google profiles, which anybody can set.
  it('escapes names in the HTML', () => {
    const email = renderInviteEmail(
      {
        ...STUDENT,
        invitedBy: {
          firstName: '<img src=x onerror=alert(1)>',
          lastName: null,
        },
      },
      LINK,
    );

    expect(email.html).not.toContain('<img');
    expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('renderInviteTemplateEmail', () => {
  const TEMPLATES = {
    standard: 'campus-invite',
    admin: 'campus-invite-admin',
    guest: 'campus-invite-guest',
  };
  const GUEST: InvitePreviewResponseDto = {
    ...STUDENT,
    cohortRole: CohortRole.Guest,
    track: null,
    guestAccessExpiresAt: new Date('2026-10-05T17:00:00.000Z'),
  };
  const ADMIN: InvitePreviewResponseDto = {
    ...STUDENT,
    cohort: null,
    track: null,
    cohortRole: null,
    systemRole: SystemRole.Admin,
  };
  const template = (
    invite: InvitePreviewResponseDto,
    templates: { standard: string; admin?: string; guest?: string } = TEMPLATES,
  ) => renderInviteTemplateEmail(invite, LINK, templates).template;

  // Resend refuses a send that leaves a template's variable out, so these
  // names are what each template there has to declare, no more and no fewer.
  it.each([
    [
      'standard',
      STUDENT,
      [
        'COHORT',
        'EXPIRES_AT',
        'INVITEE_EMAIL',
        'INVITE_LINK',
        'JOINING',
        'ROLE',
        'SITE_URL',
        'TRACK',
      ],
    ],
    [
      'admin',
      ADMIN,
      ['EXPIRES_AT', 'INVITEE_EMAIL', 'INVITE_LINK', 'SITE_URL'],
    ],
    [
      'guest',
      GUEST,
      [
        'ACCESS_ENDS',
        'COHORT',
        'EXPIRES_AT',
        'INVITEE_EMAIL',
        'INVITE_LINK',
        'SITE_URL',
      ],
    ],
  ])("fills exactly the %s template's variables", (_name, invite, names) => {
    expect(Object.keys(template(invite).variables).sort()).toEqual(names);
  });

  it('describes a cohort invite tile by tile', () => {
    expect(template(STUDENT)).toMatchObject({
      id: 'campus-invite',
      variables: {
        JOINING: 'Product Design 2026',
        COHORT: 'Product Design 2026',
        ROLE: 'Student',
        TRACK: 'Product Design',
        EXPIRES_AT: '7 October 2026, 12:00 UTC',
        SITE_URL: 'https://dev.campusbyrise.com',
      },
    });
  });

  it('sends a guest their own template, with when the visit ends', () => {
    expect(template(GUEST)).toMatchObject({
      id: 'campus-invite-guest',
      variables: {
        COHORT: 'Product Design 2026',
        ACCESS_ENDS: '5 October 2026, 17:00 UTC',
      },
    });
  });

  it('sends an admin their own template, which names no cohort', () => {
    const { id, variables } = template(ADMIN);

    expect(id).toBe('campus-invite-admin');
    expect(variables).not.toHaveProperty('COHORT');
  });

  // system_role is independent of the cohort, so this is a cohort invite.
  it('sends an admin who is joining a cohort the standard template', () => {
    expect(template({ ...STUDENT, systemRole: SystemRole.Admin }).id).toBe(
      'campus-invite',
    );
  });

  describe('with only the standard template', () => {
    const ONLY = { standard: 'campus-invite' };

    it('still tells a guest when their visit ends, beside the role', () => {
      const { id, variables } = template(GUEST, ONLY);

      expect(id).toBe('campus-invite');
      expect(variables.ROLE).toBe(
        'Guest (access ends 5 October 2026, 17:00 UTC)',
      );
      expect(variables.TRACK).toBe('—');
    });

    it('leaves no tile empty for an admin invite, which has no cohort', () => {
      expect(template(ADMIN, ONLY)).toMatchObject({
        id: 'campus-invite',
        variables: {
          JOINING: 'Campus by Rise',
          COHORT: '—',
          ROLE: 'Admin',
          TRACK: '—',
        },
      });
    });
  });
});
