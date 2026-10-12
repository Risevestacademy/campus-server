import {
  escapeHtml,
  type RenderedEmail,
} from '../../infra/email/rendered-email.js';

/**
 * The email telling an admin a report has come in.
 *
 * It says that there is one and where to read it, and nothing of what it
 * says. A report is one member's account of another, and an inbox is not
 * the place for it: mail is forwarded, searched and kept long after the
 * matter is closed.
 */
export function renderFeedbackReportEmail(appUrl: string): RenderedEmail {
  const subject = 'A member has sent a report';
  const intro =
    'A member has sent a report through Campus. It is waiting in the ' +
    'feedback list for an admin to read.';
  const outro =
    'This email does not say what the report is about, on purpose. Sign in ' +
    'to read it.';

  const text = ['Hi,', intro, appUrl, outro].join('\n\n');

  const paragraph = (line: string) =>
    `<p style="margin:0 0 16px">${escapeHtml(line)}</p>`;
  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1a1a1a">
    <div style="max-width:560px;margin:0 auto">
      ${paragraph('Hi,')}
      ${paragraph(intro)}
      <p style="margin:0 0 16px">
        <a href="${escapeHtml(appUrl)}" style="display:inline-block;padding:12px 20px;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold">Open Campus</a>
      </p>
      <p style="margin:24px 0 0;font-size:14px;color:#555555">${escapeHtml(outro)}</p>
    </div>
  </body>
</html>`;

  return { subject, html, text };
}
