import { describe, expect, it } from 'vitest';

import { SayBudget, inEarshot, type Standing } from './earshot.js';

const at = (
  userId: string,
  x: number,
  y: number,
  spaceKey = 'hall',
): Standing => ({
  userId,
  spaceKey,
  x,
  y,
});

describe('inEarshot', () => {
  const ada = at('ada', 0, 0);

  it('reaches everybody in a whole-room space, however far, and nobody outside it', () => {
    const others = [at('grace', 9, 9), at('linus', 1, 0, 'library')];

    expect(inEarshot(ada, others, { kind: 'room' })).toEqual([others[0]]);
  });

  it('reaches only those within the radius in a proximity space, the edge included', () => {
    const others = [at('grace', 3, 4), at('linus', 4, 4), at('alan', 1, 1)];

    expect(
      inEarshot(ada, others, { kind: 'proximity', radius: 5 }).map(
        (other) => other.userId,
      ),
    ).toEqual(['grace', 'alan']);
  });

  it('never counts the speaker among the listeners', () => {
    expect(inEarshot(ada, [ada], { kind: 'room' })).toEqual([]);
  });
});

describe('SayBudget', () => {
  it('lets five lines through at once, then one a second', () => {
    const budget = new SayBudget(0);

    expect([1, 2, 3, 4, 5].map(() => budget.admit(0))).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(budget.admit(0)).toBe(false);
    expect(budget.admit(999)).toBe(false);
    expect(budget.admit(1_000)).toBe(true);
  });

  it('does not count a clock stepped back against the speaker', () => {
    const budget = new SayBudget(10_000);
    for (let i = 0; i < 5; i += 1) budget.admit(10_000);

    expect(budget.admit(5_000)).toBe(false);
    expect(budget.admit(11_000)).toBe(true);
  });
});
