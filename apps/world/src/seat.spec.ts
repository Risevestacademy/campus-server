import { describe, expect, it } from 'vitest';

import { SeatMap } from './seat.js';

const ada = { userId: 'ada', cohortId: 'cohort-1' };
const grace = { userId: 'grace', cohortId: 'cohort-1' };

describe('SeatMap', () => {
  it('sets a value and gets it back by the seat, not the object', () => {
    const seats = new SeatMap<string>();
    seats.set(ada, 'here');

    expect(seats.get({ ...ada })).toBe('here');
    expect(seats.get({ ...ada, cohortId: 'cohort-2' })).toBeUndefined();
  });

  it('says whether a seat is there', () => {
    const seats = new SeatMap<string>();
    seats.set(ada, 'here');

    expect(seats.has({ ...ada })).toBe(true);
    expect(seats.has(grace)).toBe(false);
  });

  it('deletes by seat, answering as a Map does', () => {
    const seats = new SeatMap<string>();
    seats.set(ada, 'here');

    expect(seats.delete({ ...ada })).toBe(true);
    expect(seats.delete({ ...ada })).toBe(false);
    expect(seats.has(ada)).toBe(false);
  });

  it('keeps the original position when a seat is set again', () => {
    const seats = new SeatMap<string>();
    seats.set(ada, 'first');
    seats.set(grace, 'second');
    seats.set({ ...ada }, 'third');

    expect([...seats.values()]).toEqual(['third', 'second']);
  });

  it('moves a deleted seat to the end when set again', () => {
    const seats = new SeatMap<string>();
    seats.set(ada, 'first');
    seats.set(grace, 'second');
    seats.delete(ada);
    seats.set(ada, 'third');

    expect([...seats.values()]).toEqual(['second', 'third']);
  });

  it('values come back in insertion order', () => {
    const seats = new SeatMap<string>();
    seats.set(ada, 'first');
    seats.set(grace, 'second');

    expect([...seats.values()]).toEqual(['first', 'second']);
  });

  it('counts its live entries', () => {
    const seats = new SeatMap<string>();
    expect(seats.size).toBe(0);

    seats.set(ada, 'first');
    seats.set(grace, 'second');
    expect(seats.size).toBe(2);

    seats.delete(ada);
    expect(seats.size).toBe(1);
  });

  it('empties on clear', () => {
    const seats = new SeatMap<string>();
    seats.set(ada, 'first');

    seats.clear();

    expect(seats.size).toBe(0);
    expect([...seats.values()]).toEqual([]);
  });

  it('iterates values', () => {
    const seats = new SeatMap<string>();
    seats.set(ada, 'first');
    seats.set(grace, 'second');

    expect([...seats]).toEqual(['first', 'second']);
  });

  it('does not collide two seats that concatenate the same way', () => {
    const seats = new SeatMap<string>();
    seats.set({ userId: 'ab', cohortId: 'c' }, 'first');
    seats.set({ userId: 'a', cohortId: 'bc' }, 'second');

    expect(seats.size).toBe(2);
  });

  it('holds one entry for two seat objects with the same user and cohort', () => {
    const seats = new SeatMap<string>();
    seats.set(ada, 'first');
    seats.set({ userId: ada.userId, cohortId: ada.cohortId }, 'second');

    expect(seats.size).toBe(1);
    expect(seats.get({ ...ada })).toBe('second');
  });

  it('iterates the live map, so deleting the current entry carries on', () => {
    const seats = new SeatMap<string>();
    seats.set({ userId: 'a', cohortId: 'cohort-1' }, 'a');
    seats.set({ userId: 'b', cohortId: 'cohort-1' }, 'b');
    seats.set({ userId: 'c', cohortId: 'cohort-1' }, 'c');
    const seen: string[] = [];

    for (const value of seats) {
      seen.push(value);
      if (value === 'a') seats.delete({ userId: 'a', cohortId: 'cohort-1' });
    }

    expect(seen).toEqual(['a', 'b', 'c']);
    expect([...seats.values()]).toEqual(['b', 'c']);
  });

  it('iterates the live map, so an entry deleted before its turn is skipped', () => {
    const seats = new SeatMap<string>();
    seats.set({ userId: 'a', cohortId: 'cohort-1' }, 'a');
    seats.set({ userId: 'b', cohortId: 'cohort-1' }, 'b');
    seats.set({ userId: 'c', cohortId: 'cohort-1' }, 'c');
    const seen: string[] = [];

    for (const value of seats) {
      seen.push(value);
      if (value === 'a') seats.delete({ userId: 'b', cohortId: 'cohort-1' });
    }

    expect(seen).toEqual(['a', 'c']);
  });
});
