import { describe, expect, it } from 'vitest';

import { seatKey, type Seat } from '../seat.js';
import { Players, STEP_BURST } from './players.js';

const STEP_MS = 100;
/** The cohort a test stands in, unless it is about more than one. */
const C = 'frontend';
/**
 * A seat: Ada in the test's own cohort unless somebody, or a cohort, is named.
 * Named fields, as everywhere else, so the two cannot be given the wrong way
 * round.
 */
const at = ({ userId = 'ada', cohortId = C }: Partial<Seat> = {}): Seat => ({
  userId,
  cohortId,
});

/** 5 × 4, spawning in the top-left corner so two edges are one step away. */
function players() {
  return new Players({ width: 5, height: 4, spawn: { x: 0, y: 0 } }, STEP_MS);
}

describe('Players', () => {
  it('places an arrival on the spawn tile, facing down', () => {
    expect(players().join(at(), 0)).toEqual({
      userId: 'ada',
      x: 0,
      y: 0,
      facing: 'down',
    });
  });

  /** Two tabs in one cohort are one person: the second must not reset where the first walked to. */
  it('leaves somebody where they are when they join again', () => {
    const world = players();
    world.join(at(), 0);
    world.move(at(), 'right', 0);

    expect(world.join(at(), 0)).toMatchObject({ x: 1, y: 0 });
  });

  it('moves one tile in the direction asked', () => {
    const world = players();
    world.join(at(), 0);

    expect(world.move(at(), 'right', 0)).toEqual({
      outcome: 'moved',
      player: { userId: 'ada', x: 1, y: 0, facing: 'right' },
      changed: true,
    });
    expect(world.move(at(), 'down', 0).player).toMatchObject({
      x: 1,
      y: 1,
    });
  });

  it('will not walk off the map', () => {
    const world = players();
    world.join(at(), 0);

    const result = world.move(at(), 'up', 0);

    expect(result.outcome).toBe('blocked');
    expect(result.player).toMatchObject({ x: 0, y: 0 });
  });

  /**
   * Who may stand where is the caller's to say: a floor tile it turns down is
   * refused like a wall, turn and all, and the step's time is spent.
   */
  it('refuses a floor tile the caller will not admit, turning them toward it', () => {
    const world = players();
    world.join(at(), 0);
    const asked: { x: number; y: number }[] = [];

    expect(
      world.move(at(), 'right', 0, (target) => {
        asked.push(target);
        return false;
      }),
    ).toMatchObject({
      outcome: 'refused',
      player: { x: 0, y: 0, facing: 'right' },
      changed: true,
    });
    expect(asked).toEqual([{ x: 1, y: 0 }]);
    expect(world.move(at(), 'right', 1_000, () => true)).toMatchObject({
      outcome: 'moved',
      player: { x: 1, y: 0 },
    });
  });

  it('never asks about a wall: a wall is blocked before anybody is', () => {
    const world = players();
    world.join(at(), 0);
    let asked = false;

    expect(
      world.move(at(), 'left', 0, () => {
        asked = true;
        return false;
      }),
    ).toMatchObject({ outcome: 'blocked' });
    expect(asked).toBe(false);
  });

  /** Walking into a wall still turns you to face it, and others should see that. */
  it('turns toward a blocked tile, and reports the turn as a change', () => {
    const world = players();
    world.join(at(), 0);

    expect(world.move(at(), 'left', 0)).toMatchObject({
      outcome: 'blocked',
      player: { facing: 'left' },
      changed: true,
    });
    // Already facing it: nothing for anybody else to redraw.
    expect(world.move(at(), 'left', 1_000)).toMatchObject({
      outcome: 'blocked',
      changed: false,
    });
  });

  it('stops at a wall as it does at the edge, turning to face it', () => {
    // 3 × 1 with the middle tile walled off.
    const world = new Players(
      {
        width: 3,
        height: 1,
        spawn: { x: 0, y: 0 },
        walls: Uint8Array.from([0, 1, 0]),
      },
      STEP_MS,
    );
    world.join(at(), 0);

    expect(world.move(at(), 'right', 1_000)).toMatchObject({
      outcome: 'blocked',
      player: { x: 0, y: 0, facing: 'right' },
      changed: true,
    });
  });

  it('stops at the far edges too', () => {
    const world = players();
    world.join(at(), 0);
    let now = 0;
    for (let i = 0; i < 10; i++) {
      world.move(at(), 'right', (now += STEP_MS));
      world.move(at(), 'down', (now += STEP_MS));
    }

    expect(world.in(C)[0]).toMatchObject({ x: 4, y: 3 });
  });

  it('allows a short burst of steps sent together', () => {
    const world = players();
    world.join(at(), 0);

    const outcomes = Array.from(
      { length: STEP_BURST },
      () => world.move(at(), 'right', 0).outcome,
    );

    expect(outcomes).toEqual(Array(STEP_BURST).fill('moved'));
  });

  /** Otherwise a modified client walks the whole map in one frame. */
  it('refuses steps past the burst until time has passed', () => {
    const world = players();
    world.join(at(), 0);
    for (let i = 0; i < STEP_BURST; i++) world.move(at(), 'down', 0);

    const refused = world.move(at(), 'right', 0);
    expect(refused).toEqual({
      outcome: 'too_fast',
      // Not even turned: a refused step does nothing at all.
      player: { userId: 'ada', x: 0, y: 3, facing: 'down' },
      changed: false,
    });

    expect(world.move(at(), 'right', STEP_MS).outcome).toBe('moved');
  });

  it('walks indefinitely at exactly the step rate', () => {
    const world = new Players(
      { width: 1_000, height: 1, spawn: { x: 0, y: 0 } },
      STEP_MS,
    );
    world.join(at(), 0);

    const outcomes = new Set<string>();
    for (let i = 1; i <= 500; i++) {
      outcomes.add(world.move(at(), 'right', i * STEP_MS).outcome);
    }

    expect([...outcomes]).toEqual(['moved']);
    expect(world.in(C)[0]?.x).toBe(500);
  });

  /** A long pause must not bank a run of instant steps beyond the burst. */
  it('does not save up steps beyond the burst', () => {
    const world = new Players(
      { width: 100, height: 1, spawn: { x: 0, y: 0 } },
      STEP_MS,
    );
    world.join(at(), 0);

    const later = 60_000;
    const outcomes = Array.from(
      { length: STEP_BURST + 1 },
      () => world.move(at(), 'right', later).outcome,
    );

    expect(outcomes.at(-1)).toBe('too_fast');
  });

  /** A blocked step takes a step's time, or spinning in place would be free. */
  it('spends a step on a blocked move', () => {
    const world = players();
    world.join(at(), 0);
    for (let i = 0; i < STEP_BURST; i++) world.move(at(), 'up', 0);

    expect(world.move(at(), 'right', 0).outcome).toBe('too_fast');
  });

  it('does not take steps away when the clock goes backwards', () => {
    const world = players();
    world.join(at(), 10_000);

    expect(world.move(at(), 'right', 5_000).outcome).toBe('moved');
    expect(world.move(at(), 'right', 5_000).outcome).toBe('moved');
  });

  it('forgets somebody who leaves, and places them at spawn when they return', () => {
    const world = players();
    world.join(at(), 0);
    world.move(at(), 'right', 0);

    expect(world.leave(at(), 0, true)).toBe(true);
    expect(world.leave(at(), 0, true)).toBe(false);
    expect(world.has(at())).toBe(false);
    // No grace configured: nothing to come back to.
    expect(world.join(at(), 0)).toMatchObject({ x: 0, y: 0 });
  });

  describe('reconnecting', () => {
    const GRACE_MS = 30_000;
    const withGrace = () =>
      new Players(
        { width: 5, height: 4, spawn: { x: 0, y: 0 } },
        STEP_MS,
        GRACE_MS,
      );

    it('puts somebody back where they stood if they return within the grace', () => {
      const world = withGrace();
      world.join(at(), 0);
      world.move(at(), 'right', 0);
      world.move(at(), 'down', 0);
      world.leave(at(), 1_000, true);

      expect(world.has(at())).toBe(false);
      expect(world.join(at(), 1_000 + GRACE_MS - 1)).toEqual({
        userId: 'ada',
        x: 1,
        y: 1,
        facing: 'down',
      });
    });

    it('puts them at the spawn once the grace has run out', () => {
      const world = withGrace();
      world.join(at(), 0);
      world.move(at(), 'right', 0);
      world.leave(at(), 1_000, true);

      expect(world.join(at(), 1_000 + GRACE_MS)).toMatchObject({
        x: 0,
        y: 0,
      });
    });

    /** Otherwise dropping and rejoining is a way to walk faster. */
    it('does not refill the step allowance on the way back', () => {
      const world = withGrace();
      world.join(at(), 0);
      for (let i = 0; i < STEP_BURST; i++) world.move(at(), 'down', 0);
      world.leave(at(), 0, true);
      world.join(at(), 0);

      expect(world.move(at(), 'right', 0).outcome).toBe('too_fast');
    });

    /** Access taken away leaves nothing to come back to. */
    it('forgets entirely when told not to remember', () => {
      const world = withGrace();
      world.join(at(), 0);
      world.move(at(), 'right', 0);
      world.leave(at(), 0, false);

      expect(world.remembered).toBe(0);
      expect(world.join(at(), 1)).toMatchObject({ x: 0, y: 0 });
    });

    it('forgets a remembered position when later told not to remember', () => {
      const world = withGrace();
      world.join(at(), 0);
      world.move(at(), 'right', 0);
      world.leave(at(), 0, true);

      // Already off the map; the second leave still clears what was kept.
      expect(world.leave(at(), 1, false)).toBe(false);
      expect(world.join(at(), 2)).toMatchObject({ x: 0, y: 0 });
    });

    it('uses a remembered position once', () => {
      const world = withGrace();
      world.join(at(), 0);
      world.move(at(), 'right', 0);
      world.leave(at(), 0, true);
      world.join(at(), 1);

      expect(world.remembered).toBe(0);
    });

    it('lets go of positions nobody came back for', () => {
      const world = withGrace();
      for (const id of ['ada', 'grace', 'lin'])
        world.join(at({ userId: id }), 0);
      world.move(at({ userId: 'lin' }), 'right', 0);
      world.leave(at(), 0, true);
      world.leave(at({ userId: 'grace' }), 10_000, true);
      world.leave(at({ userId: 'lin' }), 20_000, true);

      world.forgetExpired(GRACE_MS + 10_000);

      // ada's and grace's grace ran out; lin's has not.
      expect(world.remembered).toBe(1);
      expect(
        world.join(at({ userId: 'lin' }), GRACE_MS + 10_000),
      ).toMatchObject({
        x: 1,
        y: 0,
      });
    });

    it('resumes a position only in the cohort it was left in', () => {
      const world = withGrace();
      world.join(at({ cohortId: 'frontend' }), 0);
      world.move(at({ cohortId: 'frontend' }), 'right', 0);
      world.leave(at({ cohortId: 'frontend' }), 0, true);

      // Another cohort starts fresh, not where they stood in Frontend, and
      // leaves the memory there alone.
      expect(world.join(at({ cohortId: 'backend' }), 1)).toMatchObject({
        x: 0,
        y: 0,
      });
      expect(world.isRemembered(at({ cohortId: 'frontend' }))).toBe(true);
      expect(world.isRemembered(at({ cohortId: 'backend' }))).toBe(false);
      expect(world.join(at({ cohortId: 'frontend' }), 2)).toMatchObject({
        x: 1,
        y: 0,
      });
    });

    it('forgets, when told not to remember, only the cohort named', () => {
      const world = withGrace();
      for (const cohort of ['frontend', 'backend']) {
        world.join(at({ cohortId: cohort }), 0);
        world.move(at({ cohortId: cohort }), 'right', 0);
        world.leave(at({ cohortId: cohort }), 0, true);
      }

      world.leave(at({ cohortId: 'backend' }), 1, false);

      expect(world.isRemembered(at({ cohortId: 'frontend' }))).toBe(true);
      expect(world.isRemembered(at({ cohortId: 'backend' }))).toBe(false);
    });
  });

  /** Somebody in two cohorts' campuses at once has an avatar in each. */
  describe('several cohorts at once', () => {
    it('keeps a separate avatar in each, moved separately', () => {
      const world = players();
      world.join(at({ cohortId: 'frontend' }), 0);
      world.join(at({ cohortId: 'backend' }), 0);

      world.move(at({ cohortId: 'frontend' }), 'right', 0);

      expect(world.get(at({ cohortId: 'frontend' }))).toMatchObject({
        x: 1,
        y: 0,
      });
      expect(world.get(at({ cohortId: 'backend' }))).toMatchObject({
        x: 0,
        y: 0,
      });
      expect(world.size).toBe(2);
    });

    it('lists each cohort with only those standing in it', () => {
      const world = players();
      world.join(at({ cohortId: 'frontend' }), 0);
      world.join(at({ cohortId: 'backend' }), 0);
      world.join(at({ userId: 'grace', cohortId: 'backend' }), 0);

      expect(world.in('frontend').map((p) => p.userId)).toEqual(['ada']);
      expect(
        world
          .in('backend')
          .map((p) => p.userId)
          .sort(),
      ).toEqual(['ada', 'grace']);
      expect(world.in('design')).toEqual([]);
    });

    it('takes them off one map and leaves the other', () => {
      const world = players();
      world.join(at({ cohortId: 'frontend' }), 0);
      world.join(at({ cohortId: 'backend' }), 0);

      expect(world.leave(at({ cohortId: 'frontend' }), 0, true)).toBe(true);

      expect(world.has(at({ cohortId: 'frontend' }))).toBe(false);
      expect(world.has(at({ cohortId: 'backend' }))).toBe(true);
    });

    /** Each avatar walks at the walking speed: one being busy costs the other nothing. */
    it('gives each avatar its own step allowance', () => {
      const world = players();
      world.join(at({ cohortId: 'frontend' }), 0);
      world.join(at({ cohortId: 'backend' }), 0);
      for (let i = 0; i < STEP_BURST; i++) {
        world.move(at({ cohortId: 'frontend' }), 'down', 0);
      }

      expect(world.move(at({ cohortId: 'backend' }), 'right', 0).outcome).toBe(
        'moved',
      );
    });
  });

  /** Two seats are one only when both halves match, however the strings fall. */
  it('keys a seat by account and cohort together, without collisions', () => {
    expect(seatKey(at({ cohortId: 'frontend' }))).toBe(
      seatKey(at({ cohortId: 'frontend' })),
    );
    expect(seatKey(at({ cohortId: 'frontend' }))).not.toBe(
      seatKey(at({ cohortId: 'backend' })),
    );
    expect(seatKey(at({ userId: 'ab', cohortId: 'c' }))).not.toBe(
      seatKey(at({ userId: 'a', cohortId: 'bc' })),
    );
  });

  it('hands out copies, so a caller cannot move anybody by editing one', () => {
    const world = players();
    const joined = world.join(at(), 0);
    joined.x = 3;
    world.in(C)[0]!.y = 3;

    expect(world.in(C)[0]).toMatchObject({ x: 0, y: 0 });
  });

  it('refuses to move somebody who never joined', () => {
    expect(() => players().move(at({ userId: 'nobody' }), 'up', 0)).toThrow(
      /not joined/,
    );
  });

  /** A position kept from an earlier visit, which the gateway loads from the store. */
  describe('joining with a saved position', () => {
    it('starts there', () => {
      expect(players().join(at(), 0, { x: 3, y: 2, facing: 'left' })).toEqual({
        userId: 'ada',
        x: 3,
        y: 2,
        facing: 'left',
      });
    });

    /** A map published since their last visit may have built over it. */
    it('starts at the spawn when the tile is now a wall', () => {
      const world = new Players(
        {
          width: 3,
          height: 1,
          spawn: { x: 0, y: 0 },
          walls: Uint8Array.from([0, 1, 0]),
        },
        STEP_MS,
      );

      expect(world.join(at(), 0, { x: 1, y: 0, facing: 'up' })).toMatchObject({
        x: 0,
        y: 0,
        facing: 'down',
      });
    });

    it('starts at the spawn when the tile is off the map', () => {
      expect(
        players().join(at(), 0, { x: 9, y: 2, facing: 'left' }),
      ).toMatchObject({
        x: 0,
        y: 0,
        facing: 'down',
      });
    });

    it('is ignored for somebody already here', () => {
      const world = players();
      world.join(at(), 0);

      expect(world.join(at(), 0, { x: 3, y: 2, facing: 'left' })).toMatchObject(
        { x: 0, y: 0 },
      );
    });

    /** What this process remembers is fresher than what the store kept. */
    it('is ignored for somebody returning within the grace', () => {
      const world = new Players(
        { width: 5, height: 4, spawn: { x: 0, y: 0 } },
        STEP_MS,
        1_000,
      );
      world.join(at(), 0);
      world.move(at(), 'right', 0);
      world.leave(at(), 0, true);

      expect(
        world.join(at(), 10, { x: 3, y: 2, facing: 'left' }),
      ).toMatchObject({ x: 1, y: 0 });
    });
  });
});
