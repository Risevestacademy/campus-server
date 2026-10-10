import { describe, expect, it } from 'vitest';

import { CheckBudget } from './check-budget.js';

describe('CheckBudget', () => {
  it('allows the budget, then says how long until the next', () => {
    const budget = new CheckBudget(2, 0);

    expect(budget.take('ada', 0)).toBe(0);
    expect(budget.take('ada', 1_000)).toBe(0);
    expect(budget.take('ada', 15_000)).toBe(45);
  });

  it('keeps each account to its own budget', () => {
    const budget = new CheckBudget(1, 0);

    expect(budget.take('ada', 0)).toBe(0);
    expect(budget.take('grace', 0)).toBe(0);
    expect(budget.take('ada', 0)).toBeGreaterThan(0);
  });

  it('starts afresh a minute after the window opened', () => {
    const budget = new CheckBudget(1, 0);
    budget.take('ada', 0);

    expect(budget.take('ada', 59_999)).toBe(1);
    expect(budget.take('ada', 60_000)).toBe(0);
  });

  // A refusal must not push the window back, or retrying on schedule would
  // keep somebody locked out.
  it('does not count refusals', () => {
    const budget = new CheckBudget(1, 0);
    budget.take('ada', 0);
    budget.take('ada', 30_000);
    budget.take('ada', 59_000);

    expect(budget.take('ada', 60_000)).toBe(0);
  });
});
