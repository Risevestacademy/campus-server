import { describe, expect, it } from 'vitest';

import { tileIndex } from '../movement/grid.js';
import { spaceIndexFrom } from '../movement/spaces.js';
import { SPACE_ACCESS } from '@campus/space-access';

import type { WorldSpace } from '../infra/accounts.js';
import {
  ASK_AGAIN_AFTER_MS,
  EntryRequests,
  besideSpace,
  obstacle,
  takesRequests,
} from './requests.js';

const ada = { userId: 'ada', cohortId: 'cohort-1' };

describe('EntryRequests', () => {
  it('holds one open request per person', () => {
    const requests = new EntryRequests<string>();

    expect(requests.ask(ada, 'library', 0, 'tab')).toBe('asked');
    expect(requests.ask(ada, 'lab', 0, 'tab')).toBe('already_asking');
    expect(requests.openFor(ada)).toMatchObject({
      ...ada,
      spaceKey: 'library',
      asker: 'tab',
    });
  });

  it('keeps one cohort’s requests apart from another’s', () => {
    const requests = new EntryRequests<string>();
    requests.ask(ada, 'library', 0, 'tab');

    expect(
      requests.ask({ ...ada, cohortId: 'cohort-2' }, 'library', 0, 'tab'),
    ).toBe('asked');
    expect(requests.all('cohort-1', 'library')).toEqual([
      expect.objectContaining({ ...ada, spaceKey: 'library' }),
    ]);
  });

  it('turns a yes into a pass for that space', () => {
    const requests = new EntryRequests<string>();
    requests.ask(ada, 'library', 0, 'tab');

    expect(requests.admit(ada)).toMatchObject({ ...ada, spaceKey: 'library' });
    expect(requests.openFor(ada)).toBeUndefined();
    expect(requests.passFor(ada)).toBe('library');

    requests.dropPass(ada);
    expect(requests.passFor(ada)).toBeUndefined();
  });

  it('makes them wait after a no before asking that space again', () => {
    const requests = new EntryRequests<string>();
    requests.ask(ada, 'library', 0, 'tab');
    requests.decline(ada, 1_000);

    expect(
      requests.ask(ada, 'library', 1_000 + ASK_AGAIN_AFTER_MS - 1, 'tab'),
    ).toBe('too_soon');
    expect(requests.ask(ada, 'lab', 1_000, 'tab')).toBe('asked');
    requests.close(ada);
    expect(
      requests.ask(ada, 'library', 1_000 + ASK_AGAIN_AFTER_MS, 'tab'),
    ).toBe('asked');
  });

  it('gives every request its own id, found only while it is open', () => {
    const requests = new EntryRequests<string>();
    requests.ask(ada, 'library', 0, 'tab');
    const first = requests.openFor(ada)?.id as string;

    expect(requests.find(first)).toMatchObject({ ...ada, id: first });
    requests.close(ada);
    expect(requests.find(first)).toBeUndefined();

    requests.ask(ada, 'library', 0, 'tab');
    const second = requests.openFor(ada)?.id as string;
    expect(second).not.toBe(first);
    expect(requests.find(first)).toBeUndefined();
    expect(requests.find(second)).toMatchObject({ id: second });
  });

  it('lets them ask again at once after a withdrawal', () => {
    const requests = new EntryRequests<string>();
    requests.ask(ada, 'library', 0, 'tab');
    requests.close(ada);

    expect(requests.ask(ada, 'library', 0, 'tab')).toBe('asked');
  });

  it('answers nothing for a request that is not open', () => {
    const requests = new EntryRequests<string>();

    expect(requests.admit(ada)).toBeUndefined();
    expect(requests.decline(ada, 0)).toBeUndefined();
    expect(requests.passFor(ada)).toBeUndefined();
  });
});

describe('besideSpace', () => {
  // A 4 × 3 map, the library in its right half (x 2 to 3), a wall at (1, 2).
  const walls = new Uint8Array(4 * 3);
  walls[tileIndex({ width: 4 }, { x: 1, y: 2 })] = 1;
  const grid = { width: 4, height: 3, spawn: { x: 0, y: 0 }, walls };
  const spaces = spaceIndexFrom({
    widthTiles: 4,
    heightTiles: 3,
    collisions: [],
    spawn: { x: 0, y: 0 },
    spaces: [
      {
        key: 'library',
        name: 'Library',
        kind: null,
        bounds: { shape: 'rect', x: 2, y: 0, width: 2, height: 2 },
        properties: {},
      },
    ],
    portals: [],
    desks: [],
  });

  it('is true one step from the space’s floor', () => {
    expect(besideSpace(grid, spaces, { x: 1, y: 0 }, 'library')).toBe(true);
    expect(besideSpace(grid, spaces, { x: 2, y: 2 }, 'library')).toBe(true);
  });

  it('is false further away, or only diagonally', () => {
    expect(besideSpace(grid, spaces, { x: 0, y: 0 }, 'library')).toBe(false);
    expect(besideSpace(grid, spaces, { x: 1, y: 2 }, 'library')).toBe(false);
  });

  it('is false for another space', () => {
    expect(besideSpace(grid, spaces, { x: 1, y: 0 }, 'lab')).toBe(false);
  });
});

describe('takesRequests', () => {
  const room: WorldSpace = {
    id: 'space-1',
    kind: 'meeting_room',
    access: SPACE_ACCESS.Normal,
    retiredAt: null,
    locked: false,
    grants: [],
    audioMode: 'boundary',
    audibleRadius: 5,
    subscribeRadius: 6,
    hysteresisFactor: 1.2,
  };

  it('takes requests into a locked normal space or a designated one', () => {
    expect(takesRequests(room, true)).toBe(true);
    expect(
      takesRequests({ ...room, access: SPACE_ACCESS.Designated }, false),
    ).toBe(true);
  });

  it.each<[string, WorldSpace | undefined, boolean]>([
    ['an unlocked normal space', room, false],
    ['a space with no row', undefined, true],
    ['a space not set up', { ...room, kind: null }, true],
    ['a retired space', { ...room, retiredAt: new Date() }, true],
  ])('takes none into %s', (_, space, locked) => {
    expect(takesRequests(space, locked)).toBe(false);
  });
});

describe('obstacle', () => {
  const standing = {
    mayWalkIn: false,
    takesRequests: true,
    beside: true,
    answerers: 1,
  };

  it('lets a request stand beside a space somebody inside can answer for', () => {
    expect(obstacle(standing)).toBeNull();
  });

  it('names the first thing in the way, in the order a refusal reads', () => {
    expect(
      obstacle({ ...standing, mayWalkIn: true, takesRequests: false }),
    ).toBe('may_walk_in');
    expect(obstacle({ ...standing, takesRequests: false, beside: false })).toBe(
      'no_requests',
    );
    expect(obstacle({ ...standing, beside: false, answerers: 0 })).toBe(
      'not_beside',
    );
    expect(obstacle({ ...standing, answerers: 0 })).toBe('nobody_inside');
  });
});

describe('EntryRequests passes', () => {
  it('lists the yeses not yet walked through, by cohort and space', () => {
    const requests = new EntryRequests<string>();
    requests.ask(ada, 'library', 0, 'tab');
    requests.admit(ada);

    expect(requests.allPasses('cohort-1', 'library')).toEqual([
      { ...ada, spaceKey: 'library' },
    ]);
    expect(requests.allPasses('cohort-2')).toEqual([]);
  });
});
