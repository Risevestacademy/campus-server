import { describe, expect, it } from 'vitest';

import { isCheckViolation } from './check-violation.js';
import { isConstraintViolation } from './constraint-violation.js';
import { isForeignKeyViolation } from './foreign-key-violation.js';
import { isUniqueViolation } from './unique-violation.js';

/** Wraps an error as drizzle does, or as a caller wrapping drizzle might. */
const wrap = (cause: object, message = 'Failed query: insert ...') =>
  Object.assign(new Error(message), { cause });

/** A driver error with a SQLSTATE and a constraint name, `depth` causes down. */
const nested = (depth: number, driverError: object): object => {
  let err: object = driverError;
  for (let i = 0; i < depth; i += 1) err = wrap(err, `wrapper ${i}`);
  return err;
};

describe('isConstraintViolation', () => {
  /**
   * The code and the name used to be looked for differently: the name along
   * the chain, the code only on the error and its first cause. A driver
   * error two wrappers down then had its name found and its code missed, so
   * a 400 or a 409 the caller could act on came back as a 500.
   */
  it.each([0, 1, 2, 3])(
    'finds the code and the name with the driver error %i causes down',
    (depth) => {
      const err = nested(depth, {
        code: '23505',
        constraint: 'tracks_code_unique',
      });

      expect(isConstraintViolation(err, '23505', 'tracks_code_unique')).toBe(
        true,
      );
      expect(isConstraintViolation(err, '23505')).toBe(true);
      expect(isConstraintViolation(err, '23503')).toBe(false);
      expect(isConstraintViolation(err, '23505', 'cohorts_code_unique')).toBe(
        false,
      );
    },
  );

  it('reads the name wherever each driver puts it', () => {
    for (const key of ['constraint', 'constraint_name']) {
      const err = nested(2, {
        code: '23514',
        [key]: 'feedback_title_not_blank',
      });
      expect(isCheckViolation(err, 'feedback_title_not_blank')).toBe(true);
    }
  });

  /** Each of the three helpers, on an error deeper than the old reach. */
  it('answers for every helper with the driver error two causes down', () => {
    expect(
      isUniqueViolation(
        nested(2, { code: '23505', constraint: 'tracks_code_unique' }),
        'tracks_code_unique',
      ),
    ).toBe(true);
    expect(
      isForeignKeyViolation(
        nested(2, {
          code: '23503',
          constraint_name: 'cohort_tracks_track_id_fk',
        }),
      ),
    ).toBe(true);
    expect(
      isCheckViolation(
        nested(2, { code: '23514', constraint: 'cohorts_dates_in_order' }),
        'cohorts_dates_in_order',
      ),
    ).toBe(true);
  });

  it('gives up past its depth, and on a chain that loops, rather than looping', () => {
    expect(
      isConstraintViolation(
        nested(6, { code: '23505', constraint: 'tracks_code_unique' }),
        '23505',
      ),
    ).toBe(false);

    const loop: Record<string, unknown> = { message: 'loop' };
    loop.cause = loop;
    expect(isConstraintViolation(loop, '23505')).toBe(false);
  });

  it('finds nothing in what is not an error', () => {
    for (const value of [null, undefined, 'boom', 42]) {
      expect(isConstraintViolation(value, '23505')).toBe(false);
    }
  });
});
