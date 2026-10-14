import { isCheckViolation } from './check-violation.js';

// drizzle wraps the driver error; its own message is just "Failed query: ...".
const wrapped = (cause: object) =>
  Object.assign(new Error('Failed query: insert into "feedback" ...'), {
    cause,
  });

describe('isCheckViolation', () => {
  it('matches the named check, wherever the driver puts the name', () => {
    for (const key of ['constraint', 'constraint_name']) {
      const err = wrapped({ code: '23514', [key]: 'feedback_title_not_blank' });

      expect(isCheckViolation(err, 'feedback_title_not_blank')).toBe(true);
      expect(isCheckViolation(err, 'feedback_details_not_blank')).toBe(false);
    }
  });

  it('does not match an error that is not a check violation', () => {
    const err = wrapped({
      code: '23503',
      constraint: 'feedback_title_not_blank',
    });

    expect(isCheckViolation(err, 'feedback_title_not_blank')).toBe(false);
    expect(isCheckViolation(new Error('boom'), 'anything')).toBe(false);
  });
});
