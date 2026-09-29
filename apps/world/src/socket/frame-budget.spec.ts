import { describe, expect, it } from 'vitest';

import { FrameBudget } from './frame-budget.js';

const RATE = 10;

/** Admits `count` frames at the same instant and tallies the answers. */
function burst(budget: FrameBudget, count: number, now: number) {
  const tally = { accept: 0, drop: 0, close: 0 };
  for (let i = 0; i < count; i++) tally[budget.admit(now)] += 1;
  return tally;
}

describe('FrameBudget', () => {
  it('accepts a second of frames arriving at once', () => {
    expect(burst(new FrameBudget(RATE, 0), RATE, 0)).toEqual({ accept: RATE, drop: 0, close: 0 });
  });

  it('keeps accepting a client that sends at exactly the rate', () => {
    const budget = new FrameBudget(RATE, 0);
    const answers = new Set<string>();
    for (let i = 1; i <= 1_000; i++) answers.add(budget.admit((i * 1000) / RATE));

    expect([...answers]).toEqual(['accept']);
  });

  it('closes on the first frame past the burst instead of silently dropping it', () => {
    const budget = new FrameBudget(RATE, 0);
    burst(budget, RATE, 0);

    expect(budget.admit(0)).toBe('close');
  });

  it('refills after accepted traffic slows down', () => {
    const budget = new FrameBudget(RATE, 0);
    burst(budget, RATE, 0);

    expect(budget.admit(100)).toBe('accept');
  });

  it('does not take budget away when the clock goes backwards', () => {
    const budget = new FrameBudget(RATE, 10_000);

    expect(burst(budget, RATE, 5_000)).toEqual({ accept: RATE, drop: 0, close: 0 });
  });
});
