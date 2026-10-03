import { CohortRole } from '../cohorts/schema.js';
import { SystemRole } from '../users/schema.js';
import type { InvitePreviewResponseDto } from './dto/invite-preview.dto.js';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const PRODUCT = 'Campus by Rise';

const ROLE_LABELS: Record<CohortRole, string> = {
  [CohortRole.Student]: 'student',
  [CohortRole.Professor]: 'professor',
  [CohortRole.Mentor]: 'mentor',
  [CohortRole.Guest]: 'guest',
};

/**
 * The invite email, from the same read the invitation screen uses, so the
 * email and the page it links to describe the offer the same way.
 *
 * Says which address to sign in with because sign-in matches the invite by
 * address: picking another Google account is the likeliest way to be turned
 * away.
 */
export function renderInviteEmail(
  invite: InvitePreviewResponseDto,
  link: string,
): RenderedEmail {
  const inviter = [invite.invitedBy.firstName, invite.invitedBy.lastName]
    .filter(Boolean)
    .join(' ');
  const who = inviter || 'Someone at Rise Academy';
  const where = invite.cohort ? `${invite.cohort.name} on ${PRODUCT}` : PRODUCT;

  const subject = inviter
    ? `${inviter} invited you to ${where}`
    : `You're invited to ${where}`;

  const offer = describeOffer(invite);
  const lines = {
    intro: `${who} has invited you to join ${offer}.`,
    signIn: `Sign in with the Google account for ${invite.email}. The invitation is tied to that address, so other accounts are turned away.`,
    expiry: `This invitation expires on ${formatDate(invite.expiresAt)}.`,
    guest: invite.guestAccessExpiresAt
      ? `As a guest, your access ends on ${formatDate(invite.guestAccessExpiresAt)}.`
      : null,
    ignore: `If you weren't expecting this, you can ignore this email.`,
  };

  const text = [
    'Hi,',
    lines.intro,
    `Accept your invitation: ${link}`,
    lines.signIn,
    lines.expiry,
    lines.guest,
    lines.ignore,
  ]
    .filter((line): line is string => line !== null)
    .join('\n\n');

  const paragraph = (line: string) =>
    `<p style="margin:0 0 16px">${escapeHtml(line)}</p>`;
  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1a1a1a">
    <div style="max-width:560px;margin:0 auto">
      ${paragraph('Hi,')}
      ${paragraph(lines.intro)}
      <p style="margin:24px 0">
        <a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold">Accept your invitation</a>
      </p>
      ${paragraph(lines.signIn)}
      ${paragraph(lines.expiry)}
      ${lines.guest ? paragraph(lines.guest) : ''}
      <p style="margin:24px 0 0;font-size:14px;color:#555555">${escapeHtml(lines.ignore)}</p>
    </div>
  </body>
</html>`;

  return { subject, html, text };
}

function describeOffer(invite: InvitePreviewResponseDto): string {
  if (!invite.cohort || !invite.cohortRole) {
    return invite.systemRole === SystemRole.Admin
      ? `${PRODUCT} as an admin`
      : PRODUCT;
  }
  const track = invite.track ? ` on the ${invite.track.name} track` : '';
  return `${invite.cohort.name} as a ${ROLE_LABELS[invite.cohortRole]}${track}`;
}

/** UTC and says so: the reader's timezone is unknown here. */
export function formatDate(value: Date): string {
  const date = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(value);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(value);
  return `${date}, ${time} UTC`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
