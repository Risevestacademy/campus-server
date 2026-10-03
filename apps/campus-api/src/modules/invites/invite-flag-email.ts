import { CohortRole } from '../cohorts/schema.js';
import { SystemRole } from '../users/schema.js';
import { escapeHtml, type RenderedEmail } from './invite-email.js';

/** What a flag email says, read from the invite that was flagged. */
export interface InviteFlagNotice {
  /** The admin who sent the invite — the one the email goes to. */
  inviterEmail: string;
  inviteeEmail: string;
  cohortName: string | null;
  trackName: string | null;
  cohortRole: CohortRole | null;
  systemRole: SystemRole;
  message: string;
  flaggedAt: Date;
}

/**
 * The email telling an admin their invite was flagged: whose it is, what it
 * offered, and what the invitee said is wrong, in their own words.
 *
 * Says the invite still works, because that is the thing an admin would
 * otherwise assume the wrong way round: a flag does not pause anything, so a
 * wrong offer stays acceptable until somebody revokes it.
 */
export function renderInviteFlagEmail(notice: InviteFlagNotice): RenderedEmail {
  const subject = `${notice.inviteeEmail} flagged an issue with their invite`;

  const offer = [
    ['Invited address', notice.inviteeEmail],
    ['Cohort', notice.cohortName],
    ['Track', notice.trackName],
    ['Cohort role', notice.cohortRole],
    [
      'System role',
      notice.systemRole === SystemRole.Admin ? notice.systemRole : null,
    ],
  ].filter((line): line is [string, string] => line[1] !== null);

  const intro = `${notice.inviteeEmail} says something is wrong with the invite you sent them:`;
  const outro =
    'The invite has not been paused: it can still be accepted as it stands. ' +
    'To correct it, revoke it and send a new one.';

  const text = [
    'Hi,',
    intro,
    notice.message,
    'The invite as sent:',
    offer.map(([label, value]) => `${label}: ${value}`).join('\n'),
    outro,
  ].join('\n\n');

  const paragraph = (line: string) =>
    `<p style="margin:0 0 16px">${escapeHtml(line)}</p>`;
  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1a1a1a">
    <div style="max-width:560px;margin:0 auto">
      ${paragraph('Hi,')}
      ${paragraph(intro)}
      <blockquote style="margin:0 0 16px;padding:12px 16px;border-left:4px solid #1a1a1a;background:#f5f5f5;white-space:pre-wrap">${escapeHtml(notice.message)}</blockquote>
      ${paragraph('The invite as sent:')}
      <p style="margin:0 0 16px">${offer
        .map(([label, value]) => `${escapeHtml(label)}: ${escapeHtml(value)}`)
        .join('<br>')}</p>
      <p style="margin:24px 0 0;font-size:14px;color:#555555">${escapeHtml(outro)}</p>
    </div>
  </body>
</html>`;

  return { subject, html, text };
}
