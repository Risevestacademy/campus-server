import { isUniqueViolation } from './unique-violation.js';

// drizzle wraps the driver error; its own message is just "Failed query: ...".
const wrapped = (cause: object) =>
  Object.assign(new Error('Failed query: insert into "tracks" ...'), { cause });

describe('isUniqueViolation', () => {
  it('reads the constraint postgres.js reports as constraint_name', () => {
    const err = wrapped({
      code: '23505',
      constraint_name: 'tracks_code_unique',
      message:
        'duplicate key value violates unique constraint "tracks_code_unique"',
    });
    expect(isUniqueViolation(err, 'tracks_code_unique')).toBe(true);
  });

  it('reads the constraint PGlite reports as constraint', () => {
    const err = wrapped({ code: '23505', constraint: 'cohorts_code_unique' });
    expect(isUniqueViolation(err, 'cohorts_code_unique')).toBe(true);
  });

  it('does not match a duplicate on a different constraint', () => {
    const err = wrapped({ code: '23505', constraint: 'cohorts_code_unique' });
    expect(isUniqueViolation(err, 'tracks_code_unique')).toBe(false);
  });

  it('does not match an error that is not a unique violation', () => {
    const err = wrapped({
      code: '23503',
      constraint: 'tracks_code_unique',
    });
    expect(isUniqueViolation(err, 'tracks_code_unique')).toBe(false);
  });
});
