import { CohortRole } from '../cohorts/schema.js';
import { SystemRole } from '../users/schema.js';
import {
  renderInviteFlagEmail,
  type InviteFlagNotice,
} from './invite-flag-email.js';

const NOTICE: InviteFlagNotice = {
  inviterEmail: 'admin@campus.local',
  inviteeEmail: 'ada@campus.local',
  cohortName: 'Product Design 2026',
  trackName: 'Software Engineering',
  cohortRole: CohortRole.Student,
  systemRole: SystemRole.User,
  message: 'I applied for Product Design.',
  flaggedAt: new Date('2026-10-03T12:00:00.000Z'),
};

describe('renderInviteFlagEmail', () => {
  it('says who flagged, what they wrote and what the invite offered', () => {
    const email = renderInviteFlagEmail(NOTICE);

    expect(email.subject).toBe(
      'ada@campus.local flagged an issue with their invite',
    );
    for (const part of [email.text, email.html]) {
      expect(part).toContain('I applied for Product Design.');
      expect(part).toContain('Cohort: Product Design 2026');
      expect(part).toContain('Track: Software Engineering');
      expect(part).toContain('Cohort role: student');
    }
  });

  it('tells the admin the invite can still be accepted', () => {
    expect(renderInviteFlagEmail(NOTICE).text).toContain(
      'it can still be accepted as it stands',
    );
  });

  it('leaves out what an admin invite does not have', () => {
    const email = renderInviteFlagEmail({
      ...NOTICE,
      cohortName: null,
      trackName: null,
      cohortRole: null,
      systemRole: SystemRole.Admin,
    });

    expect(email.text).not.toContain('Cohort:');
    expect(email.text).not.toContain('Track:');
    expect(email.text).toContain('System role: admin');
  });

  // The message is the one part of this email a stranger wrote.
  it('escapes the message in the HTML part', () => {
    const email = renderInviteFlagEmail({
      ...NOTICE,
      message: '<img src=x onerror=alert(1)>',
    });

    expect(email.html).not.toContain('<img');
    expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
