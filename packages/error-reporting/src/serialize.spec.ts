import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { serializeError } from './serialize.js';
import { captureLines } from './testing.js';

/** Shaped like postgres.js's PostgresError, whose `detail` can quote a row. */
function postgresError() {
  return Object.assign(
    new Error('duplicate key value violates unique constraint "users_email"'),
    {
      name: 'PostgresError',
      code: '23505',
      severity: 'ERROR',
      detail: 'Key (email)=(ada@example.com) already exists.',
    },
  );
}

/** Shaped like drizzle's DrizzleQueryError. */
function drizzleError() {
  const query = 'insert into "users" ("email") values ($1)';
  return Object.assign(
    new Error(`Failed query: ${query}\nparams: ada@example.com`, {
      cause: postgresError(),
    }),
    { query, params: ['ada@example.com'] },
  );
}

function logger() {
  const { stream, lines } = captureLines();
  return { log: pino({ serializers: { err: serializeError } }, stream), lines };
}

describe('serializeError', () => {
  it('logs a failed query by its statement and SQLSTATE, none of its values', () => {
    const { log, lines } = logger();

    log.error({ err: drizzleError() }, 'could not create the account');

    const line = JSON.parse(lines[0]) as { err: { message: string } };
    expect(line.err.message).toContain(
      'Failed query: insert into "users" ("email") values ($1)',
    );
    expect(line.err.message).toContain('SQLSTATE 23505');
    expect(lines[0]).not.toContain('ada@example.com');
  });

  it('scrubs a warn line too', () => {
    const { log, lines } = logger();

    log.warn({ err: postgresError() }, 'retrying');

    expect(lines[0]).toContain('SQLSTATE 23505');
    expect(lines[0]).not.toContain('ada@example.com');
  });

  it('logs any other error as pino would', () => {
    const { log, lines } = logger();

    log.error({ err: new Error('boom') }, 'failed');

    const line = JSON.parse(lines[0]) as { err: Record<string, unknown> };
    expect(line.err).toMatchObject({ type: 'Error', message: 'boom' });
    expect(line.err.stack).toContain('    at ');
  });

  it("scrubs pino's serialized error, as pino-http hands it over", () => {
    const serialized = pino.stdSerializers.err(drizzleError());

    expect(JSON.stringify(serializeError(serialized))).not.toContain(
      'ada@example.com',
    );
  });

  it('passes what is not an error through', () => {
    expect(serializeError('not an error')).toBe('not an error');
    expect(serializeError(null)).toBeNull();
  });
});
