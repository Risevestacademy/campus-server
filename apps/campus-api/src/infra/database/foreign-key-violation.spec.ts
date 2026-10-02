import { isForeignKeyViolation } from './foreign-key-violation.js';

// drizzle wraps the driver error; its own message is just "Failed query: ...".
const wrapped = (cause: object) =>
  Object.assign(new Error('Failed query: delete from "cohorts" ...'), { cause });

describe('isForeignKeyViolation', () => {
  it('recognises a foreign key violation', () => {
    const err = wrapped({
      code: '23503',
      constraint: 'cohort_tracks_cohort_id_cohorts_id_fk',
    });
    expect(isForeignKeyViolation(err)).toBe(true);
  });

  it('matches the named constraint when one is given', () => {
    const err = wrapped({
      code: '23503',
      constraint_name: 'cohort_tracks_cohort_id_cohorts_id_fk',
    });
    expect(
      isForeignKeyViolation(err, 'cohort_tracks_cohort_id_cohorts_id_fk'),
    ).toBe(true);
    expect(isForeignKeyViolation(err, 'cohort_members_cohort_id_cohorts_id_fk')).toBe(
      false,
    );
  });

  it('does not match an error that is not a foreign key violation', () => {
    const err = wrapped({ code: '23505', constraint: 'tracks_code_unique' });
    expect(isForeignKeyViolation(err)).toBe(false);
  });
});
