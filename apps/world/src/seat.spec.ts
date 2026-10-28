import { describe, expect, it } from 'vitest';

import { SeatMap, type Seat } from './seat.js';

const at = (userId: string, cohortId: string): Seat => ({ userId, cohortId });

describe('SeatMap', () => {
  it('finds a value by account and cohort together', () => {
    const map = new SeatMap<number>();
    map.set(at('ada', 'frontend'), 1);

    expect(map.get(at('ada', 'frontend'))).toBe(1);
    expect(map.has(at('ada', 'frontend'))).toBe(true);
    expect(map.get(at('ada', 'backend'))).toBeUndefined();
    expect(map.get(at('frontend', 'ada'))).toBeUndefined();
  });

  it('replaces a value set twice for one seat, counting it once', () => {
    const map = new SeatMap<number>();
    map.set(at('ada', 'frontend'), 1);
    map.set(at('ada', 'frontend'), 2);

    expect(map.get(at('ada', 'frontend'))).toBe(2);
    expect(map.size).toBe(1);
    expect([...map.ofAccount('ada').values()]).toEqual([2]);
  });

  /** A stored undefined is still an entry, as with Map. */
  it('tells a stored undefined from no entry', () => {
    const map = new SeatMap<undefined>();
    map.set(at('ada', 'frontend'), undefined);

    expect(map.has(at('ada', 'frontend'))).toBe(true);
    expect(map.size).toBe(1);
  });

  it('deletes one seat, leaving the account in other cohorts', () => {
    const map = new SeatMap<number>();
    map.set(at('ada', 'frontend'), 1);
    map.set(at('ada', 'backend'), 2);

    expect(map.delete(at('ada', 'frontend'))).toBe(true);
    expect(map.delete(at('ada', 'frontend'))).toBe(false);
    expect(map.has(at('ada', 'frontend'))).toBe(false);
    expect(map.get(at('ada', 'backend'))).toBe(2);
    expect(map.size).toBe(1);
    expect(map.accounts).toBe(1);
    expect([...map.inCohort('frontend')]).toEqual([]);
    expect([...map.ofAccount('ada')]).toEqual([['backend', 2]]);
  });

  it('lists everybody in one cohort, in the order they came', () => {
    const map = new SeatMap<string>();
    map.set(at('ada', 'frontend'), 'a');
    map.set(at('bea', 'backend'), 'b');
    map.set(at('cy', 'frontend'), 'c');

    expect([...map.inCohort('frontend')]).toEqual([
      ['ada', 'a'],
      ['cy', 'c'],
    ]);
    expect([...map.inCohort('design')]).toEqual([]);
  });

  it('lists one account in every cohort it is in, in the order it joined them', () => {
    const map = new SeatMap<string>();
    map.set(at('ada', 'frontend'), 'f');
    map.set(at('bea', 'frontend'), 'x');
    map.set(at('ada', 'backend'), 'b');

    expect([...map.ofAccount('ada')]).toEqual([
      ['frontend', 'f'],
      ['backend', 'b'],
    ]);
    expect([...map.ofAccount('cy')]).toEqual([]);
  });

  /** One person in two cohorts is two entries, and one account. */
  it('counts entries and accounts apart', () => {
    const map = new SeatMap<number>();
    map.set(at('ada', 'frontend'), 1);
    map.set(at('ada', 'backend'), 2);
    map.set(at('bea', 'frontend'), 3);

    expect(map.size).toBe(3);
    expect(map.accounts).toBe(2);
  });

  it('walks every entry a cohort at a time, handing out the seat', () => {
    const map = new SeatMap<string>();
    map.set(at('ada', 'frontend'), 'a');
    map.set(at('bea', 'backend'), 'b');
    map.set(at('cy', 'frontend'), 'c');

    expect([...map]).toEqual([
      [at('ada', 'frontend'), 'a'],
      [at('cy', 'frontend'), 'c'],
      [at('bea', 'backend'), 'b'],
    ]);
    expect([...map.entries()]).toEqual([...map]);
    expect([...map.keys()]).toEqual([
      at('ada', 'frontend'),
      at('cy', 'frontend'),
      at('bea', 'backend'),
    ]);
    expect([...map.values()]).toEqual(['a', 'c', 'b']);
  });

  it('may be deleted from while it is walked', () => {
    const map = new SeatMap<number>();
    map.set(at('ada', 'frontend'), 1);
    map.set(at('bea', 'frontend'), 2);
    map.set(at('cy', 'backend'), 3);

    for (const [seat, value] of map) {
      if (value !== 2) map.delete(seat);
    }

    expect([...map]).toEqual([[at('bea', 'frontend'), 2]]);
  });

  it('clears everything', () => {
    const map = new SeatMap<number>();
    map.set(at('ada', 'frontend'), 1);
    map.set(at('bea', 'backend'), 2);
    map.clear();

    expect(map.size).toBe(0);
    expect(map.accounts).toBe(0);
    expect([...map]).toEqual([]);
    expect(map.has(at('ada', 'frontend'))).toBe(false);
  });

  /** A connection can be the key: what it was keyed by must not be kept. */
  it('keeps only the two ids of the object it was keyed by', () => {
    const map = new SeatMap<number>();
    const connection = { userId: 'ada', cohortId: 'frontend', socket: {} };
    map.set(connection, 1);

    const seat = [...map.keys()][0];
    expect(seat).toEqual(at('ada', 'frontend'));
    expect(seat).not.toBe(connection);
  });
});
