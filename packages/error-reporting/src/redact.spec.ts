import { Writable } from 'node:stream';

import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { LOG_REDACT_PATHS } from './redact.js';

function logged(write: (logger: pino.Logger) => void): string {
  let output = '';
  const sink = new Writable({
    write(chunk, _encoding, done) {
      output += chunk.toString();
      done();
    },
  });
  write(pino({ redact: { paths: [...LOG_REDACT_PATHS] } }, sink));
  return output;
}

describe('LOG_REDACT_PATHS', () => {
  it("redacts a secret at the top of a line, one level down, and in an error's details", () => {
    const line = logged((logger) => {
      logger.info({ email: 'top@example.com', password: 'hunter2' }, 'top');
      logger.info({ invite: { email: 'nested@example.com' } }, 'nested');
      logger.info(
        {
          err: {
            message: 'conflict',
            details: { email: 'detail@example.com' },
          },
        },
        'details',
      );
      logger.info(
        { session: { idToken: 'id-token', refreshToken: 'refresh-token' } },
        'tokens',
      );
      logger.info(
        {
          req: {
            headers: {
              cookie: 'campus_session=abc',
              authorization: 'Bearer x',
            },
          },
        },
        'headers',
      );
    });

    for (const secret of [
      'top@example.com',
      'hunter2',
      'nested@example.com',
      'detail@example.com',
      'id-token',
      'refresh-token',
      'campus_session=abc',
      'Bearer x',
    ]) {
      expect(line).not.toContain(secret);
    }
    expect(line).toContain('[Redacted]');
  });

  it('keeps everything else', () => {
    const line = logged((logger) => {
      logger.info({ inviteId: 'i-1', cohortId: 'c-1' }, 'kept');
    });

    expect(line).toContain('i-1');
    expect(line).toContain('c-1');
  });
});
