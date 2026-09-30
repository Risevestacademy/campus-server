import { CohortRole } from '../cohorts/schema.js';
import { SystemRole } from '../users/schema.js';
import type { InvitePreviewResponseDto } from './dto/invite-preview.dto.js';
import { renderInviteEmail } from './invite-email.js';

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
