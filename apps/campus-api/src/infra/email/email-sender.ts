/** Injection token for the configured EmailSender. */
export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  /** Plain-text alternative, for clients that do not render HTML. */
  text: string;
  /**
   * Makes a retried send deliver once. Resend honours it for 24 hours.
   */
  idempotencyKey?: string;
}

export type SendResult =
  { ok: true; id: string } | { ok: false; reason: string };

/**
 * Sends one email and says how it went. Never throws: every caller so far
 * treats email as a courtesy on top of something that has already happened,
 * so a failure is reported, not raised.
 */
export interface EmailSender {
  /** False when sending is switched off, so callers can say so. */
  readonly enabled: boolean;
  send(email: OutgoingEmail): Promise<SendResult>;
}

export const disabledEmailSender: EmailSender = {
  enabled: false,
  send: () => Promise.resolve({ ok: false, reason: 'email is disabled' }),
};
