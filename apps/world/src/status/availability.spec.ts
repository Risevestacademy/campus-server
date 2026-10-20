import { describe, expect, it } from 'vitest';

import { Availability, Status } from './availability.js';

const AWAY_AFTER_MS = 1_000;

describe('Availability', () => {
  it('shows what they chose', () => {
    const availability = new Availability(Status.Available, 0);

    expect(availability.choose(Status.Busy, 0)).toBe(true);
    expect(availability.shown).toBe(Status.Busy);
  });

  it('reports no change for choosing what they already show', () => {
    const availability = new Availability(Status.Busy, 0);

    expect(availability.choose(Status.Busy, 0)).toBe(false);
  });

  it('shows them away once idle for the stretch, and not before', () => {
    const availability = new Availability(Status.Available, 0);

    expect(availability.checkIdle(AWAY_AFTER_MS - 1, AWAY_AFTER_MS)).toBe(
      false,
    );
    expect(availability.checkIdle(AWAY_AFTER_MS, AWAY_AFTER_MS)).toBe(true);
    expect(availability.shown).toBe(Status.Away);
    // Already away: nothing more to tell.
    expect(availability.checkIdle(AWAY_AFTER_MS * 2, AWAY_AFTER_MS)).toBe(
      false,
    );
  });

  it('counts the stretch from the last thing they did', () => {
    const availability = new Availability(Status.Available, 0);
    availability.active(AWAY_AFTER_MS - 1);

    expect(availability.checkIdle(AWAY_AFTER_MS, AWAY_AFTER_MS)).toBe(false);
  });

  it('brings back what they chose once they are active again', () => {
    const availability = new Availability(Status.Busy, 0);
    availability.checkIdle(AWAY_AFTER_MS, AWAY_AFTER_MS);

    expect(availability.active(AWAY_AFTER_MS + 1)).toBe(true);
    expect(availability.shown).toBe(Status.Busy);
  });

  it('keeps an away they chose themselves, however active they are', () => {
    const availability = new Availability(Status.Available, 0);
    availability.choose(Status.Away, 0);

    expect(availability.active(1)).toBe(false);
    expect(availability.shown).toBe(Status.Away);
  });

  it('reports no change going idle while already choosing away', () => {
    const availability = new Availability(Status.Away, 0);

    expect(availability.checkIdle(AWAY_AFTER_MS, AWAY_AFTER_MS)).toBe(false);
    expect(availability.active(AWAY_AFTER_MS + 1)).toBe(false);
  });

  it('takes a choice made while idle as what to show', () => {
    const availability = new Availability(Status.Busy, 0);
    availability.checkIdle(AWAY_AFTER_MS, AWAY_AFTER_MS);

    expect(availability.choose(Status.Available, AWAY_AFTER_MS + 1)).toBe(true);
    expect(availability.shown).toBe(Status.Available);
  });

  it('never goes idle with a stretch of 0', () => {
    const availability = new Availability(Status.Available, 0);

    expect(availability.checkIdle(Number.MAX_SAFE_INTEGER, 0)).toBe(false);
  });

  it('does not go idle sooner when the clock steps backwards', () => {
    const availability = new Availability(Status.Available, 500);
    availability.active(100);

    expect(availability.checkIdle(AWAY_AFTER_MS, AWAY_AFTER_MS)).toBe(false);
  });
});
