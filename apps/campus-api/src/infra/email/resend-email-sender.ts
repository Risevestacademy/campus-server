import type { Resend } from 'resend';

import type { EmailSender, OutgoingEmail, SendResult } from './email-sender.js';

export interface ResendSenderOptions {
  /** How long one attempt may take. Two attempts can run. */
  attemptTimeoutMs?: number;
  /** Pause before the retry, so a brief outage has a moment to clear. */
  retryDelayMs?: number;
}

/**
 * One attempt's outcome, with whether trying again could change it. A
 * refusal (bad key, unverified domain, invalid address) will be refused
 * again; a timeout, a network error or a Resend-side failure may not.
 */
type Attempt = SendResult & { transient: boolean };

/**
 * The Resend SDK reports a refused send as `{ error }` rather than throwing,
 * but a network failure still throws, and neither has a timeout of its own.
 * All of them become a SendResult here, so callers handle one shape.
 *
 * A transient failure is retried once. That is only safe because of the
 * idempotency key: when the first attempt did reach Resend — a timeout that
 * was only slow — the retry returns that email instead of sending another.
 */
export class ResendEmailSender implements EmailSender {
  readonly enabled = true;
  private readonly attemptTimeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly client: Pick<Resend, 'emails'>,
    private readonly from: string,
    options: ResendSenderOptions = {},
  ) {
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? 5_000;
    this.retryDelayMs = options.retryDelayMs ?? 250;
  }

  async send(email: OutgoingEmail): Promise<SendResult> {
    const first = await this.attempt(email);
    // Without a key, a retry after a slow success would send a second copy.
    if (first.ok || !first.transient || !email.idempotencyKey) {
      return strip(first);
    }
    await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
    return strip(await this.attempt(email));
  }

  private async attempt(email: OutgoingEmail): Promise<Attempt> {
    try {
      const response = await withTimeout(
        this.client.emails.send(
          {
            from: this.from,
            to: [email.to],
            subject: email.subject,
            ...(email.template
              ? { template: email.template }
              : { html: email.html, text: email.text }),
          },
          email.idempotencyKey
            ? { idempotencyKey: email.idempotencyKey }
            : undefined,
        ),
        this.attemptTimeoutMs,
      );
      if (response.error) {
        const status = response.error.statusCode;
        return {
          ok: false,
          reason: `${response.error.name}: ${response.error.message}`,
          // No status means the SDK never got an answer from Resend.
          transient: status === null || status === 429 || status >= 500,
        };
      }
      return { ok: true, id: response.data.id, transient: false };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : 'unknown error',
        transient: true,
      };
    }
  }
}

function strip(attempt: Attempt): SendResult {
  return attempt.ok
    ? { ok: true, id: attempt.id }
    : { ok: false, reason: attempt.reason };
}

/**
 * Stops waiting, not the request: a send that finishes after the timeout may
 * still deliver. The retry settles most of those; one that times out twice
 * is reported as failed and may still arrive.
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
