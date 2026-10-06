/** Injection token for the configured EmailSender. */
export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

/**
 * A template kept in Resend, where it can be redesigned without a deploy.
 * The layout and the fixed copy live there; the values come from here.
 */
export interface EmailTemplate {
  /** The template's id or alias. It has to be published to be sent. */
  id: string;
  variables: Record<string, string | number>;
}

/** The body: written here, or filled into a template. Never both. */
export type EmailContent =
  | {
      html: string;
      /** Plain-text alternative, for clients that do not render HTML. */
      text: string;
      template?: never;
    }
  | { template: EmailTemplate; html?: never; text?: never };

export type OutgoingEmail = EmailContent & {
  to: string;
  /** Sent with a template too, where it replaces the template's own. */
  subject: string;
  /**
   * Makes a retried send deliver once. Resend honours it for 24 hours.
   */
  idempotencyKey?: string;
};

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
