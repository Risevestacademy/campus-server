import type { Resend } from 'resend';

import type { EmailSender, OutgoingEmail, SendResult } from './email-sender.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The Resend SDK reports a refused send as `{ error }` rather than throwing,
 * but a network failure still throws, and neither has a timeout of its own.
 * All three become a SendResult here, so callers handle one shape.
 */
export class ResendEmailSender implements EmailSender {
  readonly enabled = true;

  constructor(
    private readonly client: Pick<Resend, 'emails'>,
    private readonly from: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async send(email: OutgoingEmail): Promise<SendResult> {
    try {
      const response = await withTimeout(
        this.client.emails.send(
          {
            from: this.from,
            to: [email.to],
            subject: email.subject,
            html: email.html,
            text: email.text,
          },
          email.idempotencyKey
            ? { idempotencyKey: email.idempotencyKey }
            : undefined,
        ),
        this.timeoutMs,
      );
      if (response.error) {
        return {
          ok: false,
          reason: `${response.error.name}: ${response.error.message}`,
        };
      }
      return { ok: true, id: response.data.id };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : 'unknown error',
      };
    }
  }
}

/**
 * Stops waiting, not the request: a send that finishes after the timeout may
 * still deliver. Callers report it as unconfirmed, which is the truth.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no answer from Resend within ${ms} ms`)),
      ms,
    );
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
