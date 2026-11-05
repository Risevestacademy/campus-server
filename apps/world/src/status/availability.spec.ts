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

  describe('for a while', () => {
    const FIVE_MINUTES = 5 * 60 * 1000;

    it('shows the status until the time is up, then the one chosen before', () => {
      const availability = new Availability(Status.Available, 0);

      expect(availability.choose(Status.Busy, 0, FIVE_MINUTES)).toBe(true);
      expect(availability.shown).toBe(Status.Busy);
      expect(availability.shownUntil).toBe(FIVE_MINUTES);
      expect(availability.expire(FIVE_MINUTES - 1)).toBe(false);

      expect(availability.expire(FIVE_MINUTES)).toBe(true);
      expect(availability.shown).toBe(Status.Available);
      expect(availability.until).toBeNull();
    });

    it('reports a new time on the status already shown as a change', () => {
      const availability = new Availability(Status.Busy, 0);

      expect(availability.choose(Status.Busy, 0, FIVE_MINUTES)).toBe(true);
      expect(availability.choose(Status.Busy, 0)).toBe(true);
      expect(availability.until).toBeNull();
    });

    it('goes back past several timed choices to the last one made without a time', () => {
      const availability = new Availability(Status.Available, 0);
      availability.choose(Status.Busy, 0, FIVE_MINUTES);
      availability.choose(Status.Away, 1, FIVE_MINUTES);

      availability.expire(FIVE_MINUTES + 1);

      expect(availability.shown).toBe(Status.Available);
    });

    it('stops the timer when a status is chosen without one', () => {
      const availability = new Availability(Status.Available, 0);
      availability.choose(Status.Busy, 0, FIVE_MINUTES);
      availability.choose(Status.Away, 1);

      expect(availability.expire(FIVE_MINUTES)).toBe(false);
      expect(availability.shown).toBe(Status.Away);
    });

    it('hides the end while idle, and lets the time run out underneath', () => {
      const availability = new Availability(Status.Available, 0);
      availability.choose(Status.Busy, 0, FIVE_MINUTES);
      availability.checkIdle(AWAY_AFTER_MS, AWAY_AFTER_MS);

      expect(availability.shownUntil).toBeNull();
      expect(availability.expire(FIVE_MINUTES)).toBe(false);
      expect(availability.shown).toBe(Status.Away);
      expect(availability.active(FIVE_MINUTES + 1)).toBe(true);
      expect(availability.shown).toBe(Status.Available);
    });

    it('does not count the time running out as activity', () => {
      const availability = new Availability(Status.Available, 0);
      availability.choose(Status.Busy, 0, AWAY_AFTER_MS / 2);
      availability.expire(AWAY_AFTER_MS / 2);

      expect(availability.checkIdle(AWAY_AFTER_MS, AWAY_AFTER_MS)).toBe(true);
    });

    it('hands the timed choice to a connection taking its place', () => {
      const availability = new Availability(Status.Available, 0);
      availability.choose(Status.Busy, 0, FIVE_MINUTES);
      availability.checkIdle(AWAY_AFTER_MS, AWAY_AFTER_MS);

      const next = availability.handOver(AWAY_AFTER_MS + 1);

      expect(next.shown).toBe(Status.Busy);
      expect(next.shownUntil).toBe(FIVE_MINUTES);
      next.expire(FIVE_MINUTES);
      expect(next.shown).toBe(Status.Available);
    });
  });
});
