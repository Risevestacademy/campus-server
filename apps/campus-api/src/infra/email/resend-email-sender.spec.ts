import type { Resend } from 'resend';

import { ResendEmailSender } from './resend-email-sender.js';

const EMAIL = {
  to: 'ada@campus.local',
  subject: 'Hello',
  html: '<p>Hello</p>',
  text: 'Hello',
  idempotencyKey: 'invite/1',
};

const SENT = { data: { id: 'em_1' }, error: null };
const refused = (statusCode: number | null, name = 'validation_error') => ({
  data: null,
  error: { name, message: 'nope', statusCode },
});

function senderWith(send: ReturnType<typeof vi.fn>, attemptTimeoutMs = 1_000) {
  const client = { emails: { send } } as unknown as Pick<Resend, 'emails'>;
  return new ResendEmailSender(client, 'Campus <invites@campus.example>', {
    attemptTimeoutMs,
    retryDelayMs: 0,
  });
}

describe('ResendEmailSender', () => {
  it('sends from the configured address, with the idempotency key', async () => {
    const send = vi.fn().mockResolvedValue(SENT);

    const result = await senderWith(send).send(EMAIL);

    expect(result).toEqual({ ok: true, id: 'em_1' });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      {
        from: 'Campus <invites@campus.example>',
        to: ['ada@campus.local'],
        subject: 'Hello',
        html: '<p>Hello</p>',
        text: 'Hello',
      },
      { idempotencyKey: 'invite/1' },
    );
  });

  it('sends a template by id with its variables, and no body of its own', async () => {
    const send = vi.fn().mockResolvedValue(SENT);
    const template = { id: 'campus-invite', variables: { ROLE: 'Mentor' } };

    await senderWith(send).send({
      to: 'ada@campus.local',
      subject: 'Hello',
      template,
    });

    expect(send).toHaveBeenCalledWith(
      {
        from: 'Campus <invites@campus.example>',
        to: ['ada@campus.local'],
        subject: 'Hello',
        template,
      },
      undefined,
    );
  });

  // The SDK reports a refusal in the body rather than throwing, and the same
  // request would only be refused again.
  it('reports a refusal once, without retrying', async () => {
    const send = vi.fn().mockResolvedValue(refused(403));

    await expect(senderWith(send).send(EMAIL)).resolves.toEqual({
      ok: false,
      reason: 'validation_error: nope',
    });
    expect(send).toHaveBeenCalledOnce();
  });

  /**
   * The case the retry exists for: an attempt that timed out may have
   * reached Resend, and the idempotency key makes a second one either return
   * that email or send it — never a second copy.
   */
  it('retries a timeout once, with the same idempotency key', async () => {
    const send = vi
      .fn()
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce(SENT);

    const result = await senderWith(send, 20).send(EMAIL);

    expect(result).toEqual({ ok: true, id: 'em_1' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
  });

  it.each([
    ['a network error', () => Promise.reject(new Error('ECONNRESET'))],
    [
      'a Resend-side failure',
      () => Promise.resolve(refused(500, 'application_error')),
    ],
    [
      'rate limiting',
      () => Promise.resolve(refused(429, 'rate_limit_exceeded')),
    ],
    [
      'no answer at all',
      () => Promise.resolve(refused(null, 'application_error')),
    ],
  ])('retries %s once', async (_, fail) => {
    const send = vi
      .fn()
      .mockImplementationOnce(fail)
      .mockResolvedValueOnce(SENT);

    await expect(senderWith(send).send(EMAIL)).resolves.toEqual({
      ok: true,
      id: 'em_1',
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry, with the second reason', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'));

    await expect(senderWith(send).send(EMAIL)).resolves.toEqual({
      ok: false,
      reason: 'ETIMEDOUT',
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  // With no key, a retry after a send that was only slow would deliver twice.
  it('never retries an email without an idempotency key', async () => {
    const send = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

    const result = await senderWith(send).send({
      ...EMAIL,
      idempotencyKey: undefined,
    });

    expect(result).toEqual({ ok: false, reason: 'ECONNRESET' });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it('stops waiting on each attempt after its timeout', async () => {
    const send = vi.fn().mockReturnValue(new Promise(() => {}));

    const result = await senderWith(send, 20).send(EMAIL);

    expect(result).toEqual({
      ok: false,
      reason: 'no answer from Resend within 20 ms',
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
