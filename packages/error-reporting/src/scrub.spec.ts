import { describe, expect, it } from 'vitest';

import { scrubError, scrubExceptionList } from './scrub.js';

/** Shaped like postgres.js's PostgresError. */
function postgresError() {
  return Object.assign(
    new Error('invalid input syntax for type uuid: "ada@example.com"'),
    { name: 'PostgresError', code: '22P02', severity: 'ERROR' },
  );
}

/** Shaped like drizzle's DrizzleQueryError, which has no name of its own. */
function drizzleError(cause: unknown) {
  const query = 'select "id" from "users" where "users"."id" = $1';
  const params = 'ada@example.com';
  return Object.assign(
    new Error(`Failed query: ${query}\nparams: ${params}`, { cause }),
    { query, params },
  );
}

function everything(error: unknown): string {
  const seen: unknown[] = [];
  let current = error as { message?: string; stack?: string; cause?: unknown };
  while (current && seen.length < 6) {
    seen.push(current.message, current.stack);
    current = current.cause as typeof current;
  }
  return JSON.stringify(seen);
}

describe('scrubError', () => {
  it('keeps a failed query and its SQLSTATE, and none of the values', () => {
    const scrubbed = scrubError(drizzleError(postgresError())) as Error;

    expect(scrubbed.message).toBe(
      'Failed query: select "id" from "users" where "users"."id" = $1',
    );
    expect((scrubbed.cause as Error).message).toBe('SQLSTATE 22P02');
    expect((scrubbed.cause as Error).name).toBe('PostgresError');
    expect(everything(scrubbed)).not.toContain('ada@example.com');
  });

  it('keeps the stack frames', () => {
    const original = postgresError();
    const scrubbed = scrubError(original) as Error;

    expect(scrubbed.stack?.split('\n')[0]).toBe(
      'PostgresError: SQLSTATE 22P02',
    );
    expect(scrubbed.stack).toContain('    at ');
    expect(scrubbed.stack).not.toContain('ada@example.com');
  });

  it('scrubs a query error found among the causes', () => {
    const wrapped = new Error('could not accept the invite', {
      cause: postgresError(),
    });
    const scrubbed = scrubError(wrapped) as Error;

    expect(scrubbed.message).toBe('could not accept the invite');
    expect(everything(scrubbed)).not.toContain('ada@example.com');
  });

  it('leaves any other error as it was', () => {
    const plain = new Error('boom');

    expect(scrubError(plain)).toBe(plain);
    expect(scrubError('not an error')).toBe('not an error');
  });
});

describe('scrubExceptionList', () => {
  it('cuts the values off a failed query, and the message off a Postgres error', () => {
    expect(
      scrubExceptionList([
        {
          type: 'Error',
          value: 'Failed query: select $1\nparams: ada@example.com',
        },
        { type: 'PostgresError', value: 'invalid input: "ada@example.com"' },
        { type: 'TypeError', value: 'x is not a function' },
      ]),
    ).toEqual([
      { type: 'Error', value: 'Failed query: select $1' },
      { type: 'PostgresError', value: 'PostgresError' },
      { type: 'TypeError', value: 'x is not a function' },
    ]);
    expect(scrubExceptionList(undefined)).toBeUndefined();
  });
});
