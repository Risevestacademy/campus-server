import type { Resend } from 'resend';

import { ResendEmailSender } from './resend-email-sender.js';

const EMAIL = {
  to: 'ada@campus.local',
  subject: 'Hello',
  html: '<p>Hello</p>',
  text: 'Hello',
  idempotencyKey: 'invite/1',
};

function senderWith(send: ReturnType<typeof vi.fn>, timeoutMs?: number) {
  const client = { emails: { send } } as unknown as Pick<Resend, 'emails'>;
  return new ResendEmailSender(
    client,
    'Campus <invites@campus.example>',
    timeoutMs,
  );
}

describe('ResendEmailSender', () => {
  it('sends from the configured address, with the idempotency key', async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ data: { id: 'em_1' }, error: null });

    const result = await senderWith(send).send(EMAIL);

    expect(result).toEqual({ ok: true, id: 'em_1' });
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

  // The SDK reports a refusal in the body rather than throwing.
  it('reports a refused send without throwing', async () => {
    const send = vi.fn().mockResolvedValue({
      data: null,
      error: {
        name: 'validation_error',
        message: 'domain not verified',
        statusCode: 403,
      },
    });

    await expect(senderWith(send).send(EMAIL)).resolves.toEqual({
      ok: false,
      reason: 'validation_error: domain not verified',
    });
  });

  it('reports a network failure without throwing', async () => {
    const send = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

    await expect(senderWith(send).send(EMAIL)).resolves.toEqual({
      ok: false,
      reason: 'ECONNRESET',
    });
  });

  it('stops waiting after the timeout', async () => {
    const send = vi.fn().mockReturnValue(new Promise(() => {}));

    const result = await senderWith(send, 20).send(EMAIL);

    expect(result).toEqual({
      ok: false,
      reason: 'no answer from Resend within 20 ms',
    });
  });
});
