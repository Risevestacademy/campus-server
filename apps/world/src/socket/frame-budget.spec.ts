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

  it('drops frames past the burst, without closing on a single overrun', () => {
    const budget = new FrameBudget(RATE, 0);

    expect(burst(budget, RATE + 3, 0)).toEqual({ accept: RATE, drop: 3, close: 0 });
  });

  /** A sustained flood is deliberate, and gets the socket closed. */
  it('closes once the overrun reaches another second of frames', () => {
    const budget = new FrameBudget(RATE, 0);

    const tally = burst(budget, RATE * 3, 0);

    expect(tally.accept).toBe(RATE);
    expect(tally.drop).toBe(RATE);
    expect(tally.close).toBeGreaterThan(0);
  });

  it('forgives an overrun once the client slows down', () => {
    const budget = new FrameBudget(RATE, 0);
    burst(budget, RATE + RATE / 2, 0);

    // Two seconds of quiet pays off the debt and refills the budget.
    expect(burst(budget, RATE, 2_000)).toEqual({ accept: RATE, drop: 0, close: 0 });
  });

  it('closes a client sending at twice the rate within a few seconds', () => {
    const budget = new FrameBudget(RATE, 0);
    let closedAt: number | undefined;
    for (let i = 1; i <= RATE * 2 * 10 && closedAt === undefined; i++) {
      const now = (i * 1000) / (RATE * 2);
      if (budget.admit(now) === 'close') closedAt = now;
    }

    expect(closedAt).toBeDefined();
    expect(closedAt!).toBeLessThan(5_000);
  });

  it('does not take budget away when the clock goes backwards', () => {
    const budget = new FrameBudget(RATE, 10_000);

    expect(burst(budget, RATE, 5_000)).toEqual({ accept: RATE, drop: 0, close: 0 });
  });
});
