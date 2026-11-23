import {
  escapeHtml,
  type RenderedEmail,
} from '../../infra/email/rendered-email.js';

/** Tells the person their account was deleted, as they asked. */
export function renderAccountDeletedEmail(
  firstName: string | null,
): RenderedEmail {
  const subject = 'Your Campus account has been deleted';
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  const lines = [
    'As you asked, your Campus account has been deleted. Your name, email ' +
      'address, picture and the files you uploaded have been removed, and ' +
      'you have been signed out everywhere.',
    'Things you posted where others could see them, such as comments, stay ' +
      'in place, shown as from a deleted user.',
    'If you are invited to Campus again, you will start with a new account.',
  ];

  const text = [greeting, ...lines].join('\n\n');
  const paragraph = (line: string) =>
    `<p style="margin:0 0 16px">${escapeHtml(line)}</p>`;
  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1a1a1a">
    <div style="max-width:560px;margin:0 auto">
      ${[greeting, ...lines].map(paragraph).join('\n      ')}
    </div>
  </body>
</html>`;

  return { subject, html, text };
}
